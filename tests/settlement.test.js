'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uid, createMarket, bet, balance, assertLedgerConsistent, HOUR } = require('./helpers');
const { computeSettlement, marketStats, estimatePayout } = require('../src/services/marketMath');
const { UserError } = require('../src/utils/errors');

const code = (c) => (err) => err instanceof UserError && err.code === c;
const mkBets = (list) => list.map(([outcome, stake], i) => ({ id: i + 1, userId: uid(i + 1), outcome, stake }));
const sumPayout = (r) => r.results.reduce((a, x) => a + x.payout, 0);

test('pari-mutuel: winners get stake plus a proportional share of the losing pool', () => {
  // YES pool 600 (a 100 stake among them), NO pool 400. YES wins.
  const r = computeSettlement(mkBets([[0, 100], [0, 500], [1, 400]]), 0, 2);
  assert.equal(r.mode, 'PAYOUT');
  assert.deepEqual(r.pools, [600, 400]);
  // 100 + 100 * 400 / 600 = 166.67 -> 166 or 167 after largest-remainder rounding
  // 500 + 500 * 400 / 600 = 833.33
  const [small, big, loser] = r.results;
  assert.equal(small.status, 'WON');
  assert.equal(loser.status, 'LOST');
  assert.equal(loser.payout, 0);
  assert.equal(small.payout, 167); // remainder .67 beats .33 for the leftover point
  assert.equal(big.payout, 833);
  assert.equal(sumPayout(r), 1000);
});

test('pari-mutuel: equal pools double the winning stakes', () => {
  const r = computeSettlement(mkBets([[0, 100], [0, 400], [1, 500]]), 0, 2);
  assert.deepEqual(r.results.map((x) => x.payout), [200, 800, 0]);
});

test('rounding never creates or destroys points', () => {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 500; round++) {
    const bets = mkBets(Array.from({ length: 1 + rand(30) }, () => [rand(2), 10 + rand(5000)]));
    const winner = rand(2);
    const r = computeSettlement(bets, winner, 2);
    assert.equal(sumPayout(r), r.totalPool, `round ${round}`);
    for (const x of r.results) {
      assert.ok(Number.isInteger(x.payout) && x.payout >= 0);
      if (x.status === 'WON') assert.ok(x.payout >= x.stake, 'winners never get less than their stake');
    }
  }
});

test('ties in rounding remainders go to the earliest bet (deterministic)', () => {
  // Three equal winning bets share a losing pool of 10 -> 3.33 each, 1 leftover point.
  const r = computeSettlement(mkBets([[0, 10], [0, 10], [0, 10], [1, 10]]), 0, 2);
  assert.deepEqual(r.results.map((x) => x.payout), [14, 13, 13, 0]);
});

test('no bets: resolve without moving points', () => {
  const r = computeSettlement([], 0, 2);
  assert.equal(r.mode, 'NO_BETS');
  assert.deepEqual(r.results, []);
});

test('nobody on the winning side: everybody is refunded', () => {
  const r = computeSettlement(mkBets([[1, 100], [1, 250]]), 0, 2);
  assert.equal(r.mode, 'REFUND');
  assert.deepEqual(r.results.map((x) => [x.status, x.payout]), [['REFUNDED', 100], ['REFUNDED', 250]]);
});

test('nobody on the losing side: winners get exactly their stakes back', () => {
  const r = computeSettlement(mkBets([[0, 100], [0, 250]]), 0, 2);
  assert.equal(r.mode, 'PAYOUT');
  assert.deepEqual(r.results.map((x) => [x.status, x.payout]), [['WON', 100], ['WON', 250]]);
});

test('display stats: probabilities and estimated multipliers', () => {
  assert.deepEqual(marketStats([600, 400]).map((s) => s.probability), [60, 40]);
  assert.deepEqual(marketStats([600, 400]).map((s) => s.multiplier), [1.66, 2.5]);
  assert.deepEqual(marketStats([0, 0]).map((s) => [s.probability, s.multiplier]), [[50, null], [50, null]]);
  assert.equal(estimatePayout([600, 400], 0, 100), 157); // 100 * 1100 / 700
  assert.equal(estimatePayout([0, 0], 0, 100), 100);
});

test('end-to-end resolution pays winners and records the settlement', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services, { creator: uid(1) });
  bet(services, m.id, uid(2), 'YES', 100);
  bet(services, m.id, uid(3), 'YES', 500);
  bet(services, m.id, uid(4), 'NO', 400);
  bet(services, m.id, uid(1), 'NO', 50); // the creator bets too and loses
  advance(HOUR);
  services.markets.closeExpiredMarkets();

  const s = services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
  assert.equal(s.mode, 'PAYOUT');
  assert.equal(s.totalPaid, 1050);
  // 100 + 100*450/600 = 175 ; 500 + 500*450/600 = 875
  assert.equal(balance(services, uid(2)), 900 + 175);
  assert.equal(balance(services, uid(3)), 500 + 875);
  assert.equal(balance(services, uid(4)), 600);
  assert.equal(balance(services, uid(1)), 950, 'creator gets nothing for creating the market');

  const market = services.markets.getMarket(m.id);
  assert.equal(market.status, 'RESOLVED');
  assert.equal(market.winning_outcome, 0);
  assert.equal(market.resolver_id, uid(1));
  assert.ok(market.resolved_at);
  const record = services.settlement.getSettlement(m.id);
  assert.deepEqual(record.pools, [600, 450]);
  assert.equal(record.total_paid, 1050);
  assert.equal(record.payouts.find((p) => p.user_id === uid(2)).paid, 175);
  assert.equal(db.prepare("SELECT COUNT(*) FROM bets WHERE status = 'ACTIVE'").pluck().get(), 0);
  assertLedgerConsistent(assert, db);
});

test('market with no bets resolves without transfers', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services);
  advance(HOUR);
  const before = db.prepare('SELECT COUNT(*) FROM transactions').pluck().get();
  const s = services.settlement.resolveMarket({ marketId: m.id, outcome: 'NO', actorId: uid(1) });
  assert.equal(s.mode, 'NO_BETS');
  assert.equal(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(), before);
  assert.equal(services.markets.getMarket(m.id).status, 'RESOLVED');
});

test('market where nobody backed the winner refunds every stake', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services);
  bet(services, m.id, uid(2), 'NO', 300);
  bet(services, m.id, uid(3), 'NO', 200);
  advance(HOUR);
  const s = services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
  assert.equal(s.mode, 'REFUND');
  assert.equal(balance(services, uid(2)), 1000);
  assert.equal(balance(services, uid(3)), 1000);
  assert.equal(db.prepare("SELECT COUNT(*) FROM bets WHERE status = 'REFUNDED'").pluck().get(), 2);
  assertLedgerConsistent(assert, db);
});

test('only the creator may resolve, and only after expiry', () => {
  const { services, advance } = setup();
  const m = createMarket(services, { creator: uid(1) });
  bet(services, m.id, uid(2), 'YES', 100);
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) }), code('NOT_EXPIRED'));
  advance(HOUR);
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(2) }), code('NOT_CREATOR'));
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'MAYBE', actorId: uid(1) }), code('INVALID_OUTCOME'));
  services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
});

test('administrators can resolve expired markets with a mandatory reason and audit log', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services, { creator: uid(1) });
  advance(HOUR);
  assert.throws(
    () => services.settlement.resolveMarket({ marketId: m.id, outcome: 'NO', actorId: uid(9), isAdmin: true, reason: '  ' }),
    code('REASON_REQUIRED'),
  );
  services.settlement.resolveMarket({ marketId: m.id, outcome: 'NO', actorId: uid(9), isAdmin: true, reason: 'creator left' });
  const market = services.markets.getMarket(m.id);
  assert.equal(market.resolver_id, uid(9));
  assert.equal(market.resolved_by_admin, 1);
  const log = db.prepare("SELECT * FROM audit_logs WHERE action = 'ADMIN_MARKET_RESOLVE'").get();
  assert.equal(log.actor_id, uid(9));
  assert.equal(log.reason, 'creator left');
  assert.equal(log.target_id, String(m.id));
});

test('administrators cannot resolve before expiry (cancellation is the early exit)', () => {
  const { services } = setup();
  const m = createMarket(services);
  assert.throws(
    () => services.settlement.resolveMarket({ marketId: m.id, outcome: 'NO', actorId: uid(9), isAdmin: true, reason: 'x' }),
    code('NOT_EXPIRED'),
  );
});

test('a market can be settled only once', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services);
  bet(services, m.id, uid(2), 'YES', 100);
  bet(services, m.id, uid(3), 'NO', 100);
  advance(HOUR);
  services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
  const snapshot = [balance(services, uid(2)), balance(services, uid(3))];
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) }), code('ALREADY_SETTLED'));
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'NO', actorId: uid(1) }), code('ALREADY_SETTLED'));
  assert.throws(() => services.settlement.cancelMarket({ marketId: m.id, actorId: uid(9), reason: 'x' }), code('ALREADY_SETTLED'));
  assert.deepEqual([balance(services, uid(2)), balance(services, uid(3))], snapshot);

  // Even if the market row were tampered back to AWAITING_RESOLUTION, the unique
  // settlement record and per-bet idempotency keys block a second payout.
  db.prepare("UPDATE markets SET status = 'AWAITING_RESOLUTION', winning_outcome = NULL, resolved_at = NULL WHERE id = ?").run(m.id);
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) }), code('ALREADY_SETTLED'));
  assert.deepEqual([balance(services, uid(2)), balance(services, uid(3))], snapshot);
  assertLedgerConsistent(assert, db);
});

test('cancellation refunds every unsettled stake and is audited', () => {
  const { services, db } = setup();
  const m = createMarket(services);
  bet(services, m.id, uid(2), 'YES', 100);
  bet(services, m.id, uid(2), 'NO', 50);
  bet(services, m.id, uid(3), 'NO', 400);
  assert.throws(() => services.settlement.cancelMarket({ marketId: m.id, actorId: uid(9), reason: '' }), code('REASON_REQUIRED'));
  const s = services.settlement.cancelMarket({ marketId: m.id, actorId: uid(9), reason: 'ambiguous question' });
  assert.equal(s.totalPaid, 550);
  assert.equal(balance(services, uid(2)), 1000);
  assert.equal(balance(services, uid(3)), 1000);
  const market = services.markets.getMarket(m.id);
  assert.equal(market.status, 'CANCELLED');
  assert.equal(market.cancelled_by, uid(9));
  assert.equal(market.cancel_reason, 'ambiguous question');
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'ADMIN_MARKET_CANCEL'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM notifications WHERE kind = 'MARKET_CANCELLED'").pluck().get(), 1);
  assertLedgerConsistent(assert, db);
});

test('a failure mid-settlement rolls back everything', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services);
  bet(services, m.id, uid(2), 'YES', 100);
  bet(services, m.id, uid(3), 'YES', 100);
  bet(services, m.id, uid(4), 'NO', 100);
  advance(HOUR);
  services.markets.closeExpiredMarkets();
  const before = [uid(2), uid(3), uid(4)].map((u) => balance(services, u));

  const original = services.users.applyTransaction.bind(services.users);
  let calls = 0;
  services.users.applyTransaction = (...args) => {
    if (++calls === 2) throw new Error('simulated crash during payout');
    return original(...args);
  };
  assert.throws(() => services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) }), /simulated crash/);
  services.users.applyTransaction = original;

  assert.deepEqual([uid(2), uid(3), uid(4)].map((u) => balance(services, u)), before);
  assert.equal(services.markets.getMarket(m.id).status, 'AWAITING_RESOLUTION');
  assert.equal(services.settlement.getSettlement(m.id), null);
  assert.equal(db.prepare("SELECT COUNT(*) FROM bets WHERE status = 'ACTIVE'").pluck().get(), 3);

  // Retrying after the failure works and pays exactly once.
  services.settlement.resolveMarket({ marketId: m.id, outcome: 'YES', actorId: uid(1) });
  assert.equal(balance(services, uid(2)), 900 + 150);
  assertLedgerConsistent(assert, db);
});
