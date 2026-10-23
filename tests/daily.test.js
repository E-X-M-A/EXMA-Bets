'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uid, balance, assertLedgerConsistent, HOUR } = require('./helpers');
const { commands } = require('../src/commands');

const members = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: uid(offset + i + 1), username: `member${i + 1}` }));
// 2026-10-23 10:00 UTC = 12:00 Berlin (CEST)
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);

test('there is no manual /daily command', () => {
  assert.equal(commands.has('daily'), false);
});

test('every member receives the reward once per Berlin calendar day', async () => {
  const { services, db } = setup({ now: T0 });
  services.users.ensureUser(uid(1)); // existing account with 1000
  const result = await services.daily.distribute('2026-10-23', members(3));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.recipients, 3);
  assert.equal(result.totalPoints, 600);
  assert.equal(balance(services, uid(1)), 1200);
  // Members who never interacted get an account (initial balance) plus the reward.
  assert.equal(balance(services, uid(2)), 1200);
  assert.equal(services.users.getUser(uid(2)).last_daily_reward_date, '2026-10-23');

  const again = await services.daily.distribute('2026-10-23', members(3));
  assert.equal(again.alreadyCompleted, true);
  assert.equal(balance(services, uid(1)), 1200);
  assert.equal(db.prepare("SELECT COUNT(*) FROM transactions WHERE type = 'DAILY_REWARD'").pluck().get(), 3);
  assertLedgerConsistent(assert, db);
});

test('the database itself refuses a second reward for the same user and day', async () => {
  const { services, db } = setup({ now: T0 });
  await services.daily.distribute('2026-10-23', members(1));
  const txId = db.prepare('SELECT transaction_id FROM daily_rewards').pluck().get();
  assert.throws(
    () => db.prepare('INSERT INTO daily_rewards (user_id, reward_date, amount, transaction_id, created_at) VALUES (?, ?, 200, ?, 0)').run(uid(1), '2026-10-23', txId + 1),
    /UNIQUE|PRIMARY KEY|FOREIGN KEY/,
  );
});

test('a crash mid-distribution resumes without paying anyone twice', async () => {
  const { services, db } = setup({ now: T0 });
  const everyone = members(600); // three batches of 250
  const original = services.users.applyTransaction.bind(services.users);
  let dailyCredits = 0;
  services.users.applyTransaction = (userId, delta, opts) => {
    if (opts.type === 'DAILY_REWARD' && ++dailyCredits === 400) throw new Error('simulated crash');
    return original(userId, delta, opts);
  };
  await assert.rejects(services.daily.distribute('2026-10-23', everyone), /simulated crash/);
  services.users.applyTransaction = original;

  const partial = services.daily.getDistribution('2026-10-23');
  assert.equal(partial.status, 'FAILED');
  assert.equal(partial.recipients, 250, 'the first batch committed, the failing batch rolled back');
  assert.match(partial.last_error, /simulated crash/);

  const resumed = await services.daily.distribute('2026-10-23', everyone);
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(resumed.paidNow, 350);
  assert.equal(resumed.recipients, 600);
  assert.equal(services.daily.getDistribution('2026-10-23').attempts, 2);
  const doubles = db.prepare('SELECT user_id FROM daily_rewards GROUP BY user_id HAVING COUNT(*) > 1').all();
  assert.deepEqual(doubles, []);
  for (const m of everyone) assert.equal(balance(services, m.id), 1200);
  assertLedgerConsistent(assert, db);
});

test('pending dates: fresh install starts today, missed days are caught up (bounded)', async () => {
  const env = setup({ now: T0 });
  const { services } = env;
  assert.deepEqual(services.daily.pendingDates(), ['2026-10-23']);
  await services.daily.distribute('2026-10-23', members(2));
  assert.deepEqual(services.daily.pendingDates(), []);

  // Bot offline for three midnights: 24th, 25th and 26th are owed.
  env.advance(3 * 24 * HOUR);
  assert.deepEqual(services.daily.pendingDates(), ['2026-10-24', '2026-10-25', '2026-10-26']);
  for (const d of services.daily.pendingDates()) await services.daily.distribute(d, members(2));
  assert.equal(balance(services, uid(1)), 1000 + 4 * 200);
  assert.deepEqual(services.daily.pendingDates(), []);

  // A very long outage only backfills DAILY_MAX_BACKFILL_DAYS (7) days including today.
  env.advance(30 * 24 * HOUR);
  const pending = services.daily.pendingDates();
  assert.equal(pending.length, 7);
  assert.equal(pending.at(-1), services.daily.today());
});

test('reward days follow Europe/Berlin midnight, including DST changes', () => {
  // 2026-10-25: CEST -> CET (clocks go back at 03:00 local).
  const env = setup({ now: Date.UTC(2026, 9, 24, 21, 59, 0) }); // 23:59 Berlin on the 24th
  assert.equal(env.services.daily.today(), '2026-10-24');
  env.advance(60_000); // 22:00 UTC = 00:00 Berlin
  assert.equal(env.services.daily.today(), '2026-10-25');
  env.clock.now = Date.UTC(2026, 9, 25, 22, 59, 0); // 23:59 CET
  assert.equal(env.services.daily.today(), '2026-10-25');
  env.advance(60_000); // 23:00 UTC = 00:00 CET
  assert.equal(env.services.daily.today(), '2026-10-26');
});

test('daily rewards can be disabled with DAILY_REWARD=0', async () => {
  const { services } = setup({ now: T0, config: { dailyReward: 0 } });
  assert.deepEqual(services.daily.pendingDates(), []);
  assert.equal((await services.daily.distribute('2026-10-23', members(1))).skipped, true);
});
