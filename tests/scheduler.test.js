'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uid, createMarket, bet, balance, tempDbPath, assertLedgerConsistent, HOUR } = require('./helpers');
const { Scheduler } = require('../src/scheduler');

const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);
const memberSource = (ids) => async () => ids.map((id) => ({ id, username: `user-${id.slice(-2)}` }));

function fakePublisher(services) {
  return {
    synced: [],
    async syncAll() {
      for (const id of services.markets.marketsNeedingSync()) {
        this.synced.push(id);
        services.markets.markSynced(id, services.markets.getMarket(id).sync_version);
      }
    },
  };
}

function fakeNotifier(services) {
  return {
    delivered: [],
    async dispatch() {
      for (const n of services.outbox.due()) {
        this.delivered.push(`${n.kind}:${n.market_id}`);
        services.outbox.markSent(n.id);
      }
    },
  };
}

test('recovery after a simulated restart: expired markets close, creators notified once, rewards caught up', async () => {
  const file = tempDbPath();

  // --- First run: market created and bet on, daily reward paid, then the bot "crashes".
  let env = setup({ file, now: T0 });
  const m = createMarket(env.services, { creator: uid(1), duration: '2h' });
  bet(env.services, m.id, uid(2), 'YES', 100);
  bet(env.services, m.id, uid(3), 'NO', 100);
  await env.services.daily.distribute('2026-10-23', [{ id: uid(1) }, { id: uid(2) }, { id: uid(3) }]);
  env.db.close();

  // --- Bot is offline for two days; the market expired and two midnights passed.
  env = setup({ file, now: T0 + 2 * 24 * HOUR });
  const publisher = fakePublisher(env.services);
  const notifier = fakeNotifier(env.services);
  const scheduler = new Scheduler({
    services: env.services,
    publisher,
    notifier,
    memberSource: memberSource([uid(1), uid(2), uid(3)]),
  });
  await scheduler.reconcile();

  const market = env.services.markets.getMarket(m.id);
  assert.equal(market.status, 'AWAITING_RESOLUTION');
  assert.equal(market.totalPool, 200, 'bets survived the restart');
  assert.deepEqual(notifier.delivered, [`MARKET_EXPIRED:${m.id}`]);
  assert.ok(publisher.synced.includes(m.id), 'embed refreshed to show betting closed');
  assert.deepEqual(env.services.daily.pendingDates(), []);
  assert.equal(balance(env.services, uid(1)), 1000 + 3 * 200);
  assert.equal(balance(env.services, uid(2)), 900 + 3 * 200);

  // A second reconcile (or another restart) changes nothing and sends nothing new.
  await scheduler.reconcile();
  assert.deepEqual(notifier.delivered, [`MARKET_EXPIRED:${m.id}`]);
  assert.equal(balance(env.services, uid(1)), 1600);

  // The creator can still resolve after the restart.
  env.services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
  await scheduler.tickMarkets();
  assert.deepEqual(notifier.delivered, [
    `MARKET_EXPIRED:${m.id}`,
    `BET_RESULT:${m.id}`, // one result DM per bettor (uid 2 and uid 3); no separate result post
    `BET_RESULT:${m.id}`,
  ]);
  assert.equal(balance(env.services, uid(2)), 900 + 600 + 200);
  assertLedgerConsistent(assert, env.db);
  await scheduler.stop();
  env.db.close();
});

test('member fetch failures are recorded and retried without double payment', async () => {
  const env = setup({ now: T0 });
  let fail = true;
  const scheduler = new Scheduler({
    services: env.services,
    publisher: null,
    notifier: null,
    memberSource: async () => {
      if (fail) throw new Error('Used disallowed intents');
      return [{ id: uid(1) }, { id: uid(2) }];
    },
  });
  await scheduler.runDaily();
  const row = env.services.daily.getDistribution('2026-10-23');
  assert.equal(row.status, 'FAILED');
  assert.match(row.last_error, /disallowed intents/);
  assert.match(scheduler.lastDailyError.message, /disallowed intents/);

  fail = false;
  await scheduler.runDaily();
  await scheduler.runDaily();
  assert.equal(env.services.daily.getDistribution('2026-10-23').status, 'COMPLETED');
  assert.equal(balance(env.services, uid(1)), 1200);
  assert.equal(balance(env.services, uid(2)), 1200);
});

test('concurrent daily runs are coalesced', async () => {
  const env = setup({ now: T0 });
  let calls = 0;
  const scheduler = new Scheduler({
    services: env.services,
    memberSource: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return [{ id: uid(1) }];
    },
  });
  await Promise.all([scheduler.runDaily(), scheduler.runDaily(), scheduler.runDaily()]);
  assert.equal(calls, 1);
  assert.equal(balance(env.services, uid(1)), 1200);
});

test('start() reconciles immediately and stop() clears timers', async () => {
  const env = setup({ now: T0 });
  const m = createMarket(env.services, { duration: '1h' });
  env.advance(HOUR);
  const notifier = fakeNotifier(env.services);
  const scheduler = new Scheduler({
    services: env.services,
    publisher: fakePublisher(env.services),
    notifier,
    memberSource: memberSource([uid(5)]),
  });
  await scheduler.start();
  assert.equal(env.services.markets.getMarket(m.id).status, 'AWAITING_RESOLUTION');
  assert.equal(balance(env.services, uid(5)), 1200);
  await scheduler.stop();
  assert.equal(scheduler.timers.length, 0);
});
