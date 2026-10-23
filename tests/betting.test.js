'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { setup, uid, createMarket, bet, balance, tempDbPath, assertLedgerConsistent, HOUR, key } = require('./helpers');
const { UserError } = require('../src/utils/errors');

const code = (c) => (err) => err instanceof UserError && err.code === c;

test('a bet deducts the stake and updates pools atomically', () => {
  const { services, db } = setup();
  const m = createMarket(services);
  const r = bet(services, m.id, uid(2), 'YES', 100);
  assert.equal(r.balance, 900);
  assert.equal(r.market.totalPool, 100);
  assert.equal(r.market.outcomes[0].pool, 100);
  assert.equal(r.market.participants, 1);
  assert.equal(db.prepare("SELECT amount FROM transactions WHERE type = 'BET_STAKE'").pluck().get(), -100);
  assertLedgerConsistent(assert, db);
});

test('minimum bet and insufficient balance are enforced', () => {
  const { services } = setup();
  const m = createMarket(services);
  assert.throws(() => bet(services, m.id, uid(2), 'YES', 9), code('STAKE_TOO_SMALL'));
  assert.throws(() => bet(services, m.id, uid(2), 'YES', 1001), code('INSUFFICIENT_BALANCE'));
  assert.throws(() => bet(services, m.id, uid(2), 'YES', 0), code('INVALID_STAKE'));
  assert.throws(() => bet(services, m.id, uid(2), 'YES', 12.5), code('INVALID_STAKE'));
  bet(services, m.id, uid(2), 'YES', 1000); // exactly the balance is fine
  assert.equal(balance(services, uid(2)), 0);
  assert.throws(() => bet(services, m.id, uid(2), 'NO', 10), code('INSUFFICIENT_BALANCE'));
});

test('stake parsing accepts plain numbers, separators and "max"', () => {
  const { services } = setup();
  assert.equal(services.betting.parseStake('1,000', 5000), 1000);
  assert.equal(services.betting.parseStake(' 250 ', 5000), 250);
  assert.equal(services.betting.parseStake('max', 777), 777);
  assert.throws(() => services.betting.parseStake('-5', 100), UserError);
  assert.throws(() => services.betting.parseStake('1e3', 100), UserError);
  assert.throws(() => services.betting.parseStake('10.5', 100), UserError);
});

test('multiple bets on either side are allowed and stay locked', () => {
  const { services } = setup();
  const m = createMarket(services);
  bet(services, m.id, uid(2), 'YES', 100);
  bet(services, m.id, uid(2), 'YES', 50);
  const r = bet(services, m.id, uid(2), 'NO', 30);
  assert.equal(r.balance, 820);
  assert.equal(r.market.outcomes[0].pool, 150);
  assert.equal(r.market.outcomes[1].pool, 30);
  assert.equal(r.market.participants, 1);
  assert.equal(services.markets.userBets(m.id, uid(2)).length, 3);
});

test('creators may bet on their own markets', () => {
  const { services } = setup();
  const m = createMarket(services, { creator: uid(1) });
  assert.equal(bet(services, m.id, uid(1), 'NO', 100).balance, 900);
});

test('bets after the expiration timestamp are rejected even before the scheduler runs', () => {
  const { services, advance } = setup();
  const m = createMarket(services, { duration: '1h' });
  services.users.ensureUser(uid(3));
  advance(HOUR - 1);
  bet(services, m.id, uid(2), 'YES', 10);
  advance(1); // exactly at expiry
  assert.equal(services.markets.getMarket(m.id).status, 'OPEN', 'scheduler has not run yet');
  assert.throws(() => bet(services, m.id, uid(3), 'YES', 10), code('MARKET_CLOSED'));
  assert.equal(balance(services, uid(3)), 1000, 'no points were taken');
});

test('bets on awaiting, resolved and cancelled markets are rejected', () => {
  const { services, advance } = setup();
  const a = createMarket(services);
  const b = createMarket(services, { question: 'Second market question?' });
  services.settlement.cancelMarket({ marketId: b.id, actorId: uid(9), reason: 'test' });
  assert.throws(() => bet(services, b.id, uid(2), 'YES', 10), code('MARKET_CLOSED'));
  advance(HOUR);
  services.markets.closeExpiredMarkets();
  assert.throws(() => bet(services, a.id, uid(2), 'YES', 10), code('MARKET_CLOSED'));
  services.settlement.resolveMarket({ marketId: a.id, outcome: 'YES', actorId: uid(1) });
  assert.throws(() => bet(services, a.id, uid(2), 'YES', 10), code('MARKET_CLOSED'));
});

test('invalid outcomes and unknown markets are rejected', () => {
  const { services } = setup();
  const m = createMarket(services);
  assert.throws(() => bet(services, m.id, uid(2), 'MAYBE', 10), code('INVALID_OUTCOME'));
  assert.throws(() => bet(services, m.id, uid(2), 5, 10), code('INVALID_OUTCOME'));
  assert.throws(() => bet(services, 999, uid(2), 'YES', 10), code('MARKET_NOT_FOUND'));
  // Outcome may be given by label (any case), letter or index.
  assert.equal(bet(services, m.id, uid(2), 'yes', 10).bet.outcome, 0);
  assert.equal(bet(services, m.id, uid(2), 'B', 10).bet.outcome, 1);
  assert.equal(bet(services, m.id, uid(2), 1, 10).bet.outcome, 1);
});

test('a retried interaction never deducts twice', () => {
  const { services, db } = setup();
  const m = createMarket(services);
  const args = { marketId: m.id, userId: uid(2), outcome: 'YES', stake: 100, idempotencyKey: 'interaction-123' };
  const first = services.betting.placeBet(args);
  const second = services.betting.placeBet(args);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.bet.id, first.bet.id);
  assert.equal(balance(services, uid(2)), 900);
  assert.equal(db.prepare('SELECT COUNT(*) FROM bets').pluck().get(), 1);
});

test('confirmation buttons can only be consumed once and only by their owner', () => {
  const { services, advance } = setup();
  const m = createMarket(services);
  const id = services.confirmations.create(uid(2), 'bet', { marketId: m.id, outcome: 0, stake: 100 });
  const place = (p) =>
    services.betting.placeBet({ marketId: p.marketId, userId: uid(2), outcome: p.outcome, stake: p.stake, idempotencyKey: `confirm:${id}` });

  assert.throws(() => services.confirmations.consume(id, uid(3), 'bet', place), code('NOT_YOURS'));
  services.confirmations.consume(id, uid(2), 'bet', place);
  assert.throws(() => services.confirmations.consume(id, uid(2), 'bet', place), code('ALREADY_CONFIRMED'));
  assert.equal(balance(services, uid(2)), 900);

  const expired = services.confirmations.create(uid(2), 'bet', { marketId: m.id, outcome: 0, stake: 100 });
  advance(6 * 60_000);
  assert.throws(() => services.confirmations.consume(expired, uid(2), 'bet', place), code('CONFIRMATION_EXPIRED'));
});

test('a failed bet leaves the confirmation usable and changes nothing', () => {
  const { services } = setup();
  const m = createMarket(services);
  const id = services.confirmations.create(uid(2), 'bet', { marketId: m.id, outcome: 0, stake: 100 });
  services.users.ensureUser(uid(2));
  services.users.applyTransaction(uid(2), -950, { type: 'ADMIN_REMOVE', key: key() });
  const place = (p) =>
    services.betting.placeBet({ marketId: p.marketId, userId: uid(2), outcome: p.outcome, stake: p.stake, idempotencyKey: `confirm:${id}` });
  assert.throws(() => services.confirmations.consume(id, uid(2), 'bet', place), code('INSUFFICIENT_BALANCE'));
  assert.equal(services.markets.getMarket(m.id).totalPool, 0);
  services.users.applyTransaction(uid(2), 100, { type: 'ADMIN_GRANT', key: key() });
  services.confirmations.consume(id, uid(2), 'bet', place);
  assert.equal(services.markets.getMarket(m.id).totalPool, 100);
});

test('concurrent bets from several processes never overspend', async () => {
  const file = tempDbPath();
  const { services, db } = setup({ file, now: Date.now() });
  const m = createMarket(services, { duration: '1d' });
  services.users.ensureUser(uid(2)); // 1000 points => at most 100 bets of 10
  db.close();

  const workers = Array.from({ length: 4 }, (_, i) =>
    new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'fixtures', 'betWorker.js'), {
        workerData: { file, marketId: m.id, userId: uid(2), attempts: 60, stake: 10, worker: i },
      });
      w.once('message', resolve);
      w.once('error', reject);
    }),
  );
  const results = await Promise.all(workers);
  const placed = results.reduce((a, r) => a + r.placed, 0);
  const rejected = results.reduce((a, r) => a + r.rejected, 0);
  const unexpected = results.flatMap((r) => r.unexpected);

  const after = setup({ file, now: Date.now() });
  assert.deepEqual(unexpected, []);
  assert.equal(placed, 100);
  assert.equal(rejected, 140);
  assert.equal(balance(after.services, uid(2)), 0);
  assert.equal(after.services.markets.getMarket(m.id).totalPool, 1000);
  assertLedgerConsistent(assert, after.db);
  after.db.close();
});
