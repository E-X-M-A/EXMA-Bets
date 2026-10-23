'use strict';

const { tx } = require('../database');
const { UserError } = require('../utils/errors');
const { SNOWFLAKE_RE } = require('../config');

const MAX_POINTS = 1_000_000_000_000; // hard ceiling far below Number.MAX_SAFE_INTEGER

/**
 * Accounts and the point ledger. Every balance change goes through `applyTransaction`,
 * which updates the balance and writes a ledger row (with a unique idempotency key)
 * in the same database transaction.
 */
class UserService {
  constructor(db, config, clock = Date.now) {
    this.db = db;
    this.config = config;
    this.clock = clock;
    this.stmts = {
      get: db.prepare('SELECT * FROM users WHERE id = ?'),
      insert: db.prepare(
        'INSERT INTO users (id, username, balance, created_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT (id) DO NOTHING',
      ),
      rename: db.prepare('UPDATE users SET username = ? WHERE id = ? AND username IS NOT ?'),
      txByKey: db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?'),
      adjust: db.prepare(
        'UPDATE users SET balance = balance + @delta, updated_at = @now WHERE id = @id AND balance + @delta >= 0 RETURNING balance',
      ),
      insertTx: db.prepare(`INSERT INTO transactions
        (user_id, amount, balance_after, type, market_id, bet_id, idempotency_key, reason, created_at)
        VALUES (@userId, @amount, @balanceAfter, @type, @marketId, @betId, @key, @reason, @now)`),
    };
  }

  static assertUserId(userId) {
    if (typeof userId !== 'string' || !SNOWFLAKE_RE.test(userId)) {
      throw new UserError('Invalid Discord user.', 'INVALID_USER');
    }
  }

  /**
   * Returns the user's account, creating it with the initial balance on first contact.
   * Safe to call repeatedly: the initial grant is keyed per user.
   */
  ensureUser(userId, username = null) {
    UserService.assertUserId(userId);
    return tx(this.db, () => {
      const now = this.clock();
      const created = this.stmts.insert.run(userId, username, now, now).changes === 1;
      if (created && this.config.initialBalance > 0) {
        this.applyTransaction(userId, this.config.initialBalance, {
          type: 'INITIAL_BALANCE',
          key: `initial:${userId}`,
        });
      } else if (!created && username) {
        this.stmts.rename.run(username, userId, username);
      }
      return { ...this.stmts.get.get(userId), created };
    });
  }

  getUser(userId) {
    return this.stmts.get.get(userId) ?? null;
  }

  /**
   * Credits (delta > 0) or debits (delta < 0) a user and records it in the ledger.
   * If a ledger row with the same idempotency key exists, nothing happens and
   * `{ applied: false }` is returned. Throws UserError on insufficient balance.
   */
  applyTransaction(userId, delta, { type, key, marketId = null, betId = null, reason = null }) {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new Error(`Invalid ledger amount: ${delta}`);
    if (Math.abs(delta) > MAX_POINTS) throw new UserError('Amount is too large.', 'AMOUNT_TOO_LARGE');
    if (!key) throw new Error('Ledger entries require an idempotency key');
    return tx(this.db, () => {
      const existing = this.stmts.txByKey.get(key);
      if (existing) return { applied: false, transaction: existing, balance: this.getUser(userId).balance };
      const now = this.clock();
      const row = this.stmts.adjust.get({ delta, now, id: userId });
      if (!row) {
        if (!this.getUser(userId)) throw new Error(`Unknown user ${userId}`);
        throw new UserError('Insufficient balance.', 'INSUFFICIENT_BALANCE');
      }
      if (row.balance > MAX_POINTS) throw new UserError('That would exceed the maximum balance.', 'BALANCE_CAP');
      const info = this.stmts.insertTx.run({
        userId,
        amount: delta,
        balanceAfter: row.balance,
        type,
        marketId,
        betId,
        key,
        reason,
        now,
      });
      return { applied: true, transactionId: Number(info.lastInsertRowid), balance: row.balance };
    });
  }
}

module.exports = { UserService, MAX_POINTS };
