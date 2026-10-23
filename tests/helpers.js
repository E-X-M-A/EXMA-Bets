'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/database');
const { createServices } = require('../src/services');
const { HOUR } = require('../src/utils/time');
const logger = require('../src/utils/logger');

logger.setLevel(process.env.TEST_LOG_LEVEL || 'error');

const GUILD = '900000000000000000';
const BETTING = '900000000000000001';
const ANNOUNCE = '900000000000000002';

const baseConfig = Object.freeze({
  guildId: GUILD,
  bettingChannelId: BETTING,
  announcementChannelId: ANNOUNCE,
  initialBalance: 1000,
  dailyReward: 200,
  minBet: 10,
  leaderboardPageSize: 10,
  timezone: 'Europe/Berlin',
  dailyMaxBackfillDays: 7,
});

/** A Discord-like user id that is unique per index. */
const uid = (n) => String(100000000000000000n + BigInt(n));

/** Temporary on-disk database path (never the real bot database). */
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exma-bets-test-'));
  return path.join(dir, 'test.sqlite');
}

/**
 * Creates services with a controllable clock. Uses an in-memory database unless
 * `file` is given.
 */
function setup({ file = ':memory:', now = Date.UTC(2026, 9, 23, 10, 0, 0), config = {} } = {}) {
  const clock = { now };
  const db = openDatabase(file);
  const cfg = { ...baseConfig, ...config };
  const services = createServices(db, cfg, () => clock.now);
  return {
    db,
    services,
    config: cfg,
    clock,
    advance(ms) {
      clock.now += ms;
    },
  };
}

let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-${++keySeq}`;

function createMarket(services, { creator = uid(1), duration = '1h', outcomes = ['YES', 'NO'], question = 'Will it rain in Berlin tomorrow?' } = {}) {
  return services.markets.createMarket({ creatorId: creator, question, outcomes, duration, creationKey: key('create') }).market;
}

function bet(services, marketId, userId, outcome, stake) {
  return services.betting.placeBet({ marketId, userId, outcome, stake, idempotencyKey: key('bet') });
}

function balance(services, userId) {
  return services.users.getUser(userId)?.balance;
}

/** Sum of balances must always equal the sum of the ledger, and no points may be stranded. */
function assertLedgerConsistent(assert, db) {
  const balances = db.prepare('SELECT COALESCE(SUM(balance), 0) FROM users').pluck().get();
  const ledger = db.prepare('SELECT COALESCE(SUM(amount), 0) FROM transactions').pluck().get();
  assert.equal(balances, ledger, 'sum of balances equals ledger total');
  const perUser = db
    .prepare(`SELECT u.id FROM users u LEFT JOIN transactions t ON t.user_id = u.id
      GROUP BY u.id HAVING u.balance <> COALESCE(SUM(t.amount), 0)`)
    .all();
  assert.deepEqual(perUser, [], 'every balance equals its ledger sum');
}

module.exports = { setup, uid, key, createMarket, bet, balance, tempDbPath, assertLedgerConsistent, baseConfig, HOUR, GUILD, BETTING, ANNOUNCE };
