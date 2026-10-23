'use strict';

const crypto = require('node:crypto');
const { tx } = require('../database');
const { UserError } = require('../utils/errors');

/** Persistent audit trail for administrator (and other sensitive) actions. */
class AuditService {
  constructor(db, clock = Date.now) {
    this.clock = clock;
    this.insert = db.prepare(`INSERT INTO audit_logs (actor_id, action, target_type, target_id, reason, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.recent = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?');
  }

  log({ actorId, action, targetType = null, targetId = null, reason = null, metadata = null }) {
    this.insert.run(
      actorId,
      action,
      targetType,
      targetId == null ? null : String(targetId),
      reason,
      metadata == null ? null : JSON.stringify(metadata),
      this.clock(),
    );
  }

  list(limit = 20) {
    return this.recent.all(limit);
  }
}

/**
 * Transactional outbox for Discord side effects (DMs, announcements). Rows are
 * written in the same transaction as the state change they describe, and a unique
 * dedupe key makes sure each notification is queued at most once.
 */
class OutboxService {
  static MAX_ATTEMPTS = 8;

  constructor(db, clock = Date.now) {
    this.db = db;
    this.clock = clock;
    this.stmts = {
      insert: db.prepare(`INSERT INTO notifications (dedupe_key, kind, market_id, payload, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`),
      due: db.prepare(
        "SELECT * FROM notifications WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
      ),
      sent: db.prepare("UPDATE notifications SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE id = ?"),
      failed: db.prepare(`UPDATE notifications SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
        status = CASE WHEN attempts + 1 >= ? THEN 'FAILED' ELSE 'PENDING' END WHERE id = ?`),
    };
  }

  enqueue(dedupeKey, kind, marketId = null, payload = null) {
    const now = this.clock();
    return this.stmts.insert.run(dedupeKey, kind, marketId, payload && JSON.stringify(payload), now, now).changes === 1;
  }

  due(limit = 20) {
    return this.stmts.due.all(this.clock(), limit).map((n) => ({ ...n, payload: n.payload ? JSON.parse(n.payload) : null }));
  }

  markSent(id) {
    this.stmts.sent.run(this.clock(), id);
  }

  markFailed(id, error, attempts) {
    const backoff = Math.min(60 * 60_000, 15_000 * 2 ** attempts);
    this.stmts.failed.run(String(error).slice(0, 500), this.clock() + backoff, OutboxService.MAX_ATTEMPTS, id);
  }
}

/**
 * Short-lived, single-use confirmations behind "Confirm" buttons. The button only
 * carries a random id; the actual parameters live server-side, so they cannot be
 * tampered with, and consuming the row is atomic so a double click acts once.
 */
class ConfirmationService {
  static TTL_MS = 5 * 60_000;

  constructor(db, clock = Date.now) {
    this.db = db;
    this.clock = clock;
    this.stmts = {
      insert: db.prepare(`INSERT INTO pending_confirmations (id, user_id, kind, payload, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      get: db.prepare('SELECT * FROM pending_confirmations WHERE id = ?'),
      consume: db.prepare(
        'UPDATE pending_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?',
      ),
      purge: db.prepare('DELETE FROM pending_confirmations WHERE expires_at < ?'),
    };
  }

  create(userId, kind, payload, ttlMs = ConfirmationService.TTL_MS) {
    const id = crypto.randomBytes(12).toString('base64url');
    const now = this.clock();
    this.stmts.insert.run(id, userId, kind, JSON.stringify(payload), now, now + ttlMs);
    return id;
  }

  /** Looks up a confirmation without consuming it. Throws if missing, foreign, expired or used. */
  peek(id, userId, kind) {
    const row = this.stmts.get.get(id);
    if (!row || (kind && row.kind !== kind)) throw new UserError('This confirmation is no longer valid.', 'CONFIRMATION_INVALID');
    if (row.user_id !== userId) throw new UserError('Only the person who started this action can confirm it.', 'NOT_YOURS');
    if (row.consumed_at) throw new UserError('This action was already confirmed.', 'ALREADY_CONFIRMED');
    if (row.expires_at <= this.clock()) {
      throw new UserError('This confirmation expired. Please start again.', 'CONFIRMATION_EXPIRED');
    }
    return { ...row, payload: JSON.parse(row.payload) };
  }

  /**
   * Atomically marks the confirmation used and runs `action(payload)` in the same
   * transaction. If the action throws, the confirmation stays unused.
   */
  consume(id, userId, kind, action) {
    return tx(this.db, () => {
      const row = this.peek(id, userId, kind);
      if (this.stmts.consume.run(this.clock(), id, this.clock()).changes !== 1) {
        throw new UserError('This action was already confirmed.', 'ALREADY_CONFIRMED');
      }
      return action(row.payload, row);
    });
  }

  purgeExpired() {
    return this.stmts.purge.run(this.clock() - 24 * 60 * 60_000).changes;
  }
}

module.exports = { AuditService, OutboxService, ConfirmationService };
