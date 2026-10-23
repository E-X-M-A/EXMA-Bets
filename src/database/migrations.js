'use strict';

/**
 * Ordered, append-only list of schema migrations. Never edit a migration that has
 * shipped; add a new one instead. Each migration runs inside its own transaction.
 */
module.exports = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE users (
        id                     TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
        username               TEXT,
        balance                INTEGER NOT NULL CHECK (balance >= 0),
        last_daily_reward_date TEXT,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX idx_users_balance ON users (balance DESC, created_at, id);

      CREATE TABLE markets (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id              TEXT NOT NULL REFERENCES users (id),
        question                TEXT NOT NULL,
        description             TEXT,
        status                  TEXT NOT NULL
                                CHECK (status IN ('OPEN', 'AWAITING_RESOLUTION', 'RESOLVED', 'CANCELLED')),
        created_at              INTEGER NOT NULL,
        expires_at              INTEGER NOT NULL,
        closed_at               INTEGER,
        resolved_at             INTEGER,
        winning_outcome         INTEGER,
        resolver_id             TEXT,
        resolved_by_admin       INTEGER NOT NULL DEFAULT 0,
        cancelled_at            INTEGER,
        cancelled_by            TEXT,
        cancel_reason           TEXT,
        announcement_channel_id TEXT,
        announcement_message_id TEXT,
        creation_key            TEXT NOT NULL UNIQUE,
        sync_version            INTEGER NOT NULL DEFAULT 1,
        synced_version          INTEGER NOT NULL DEFAULT 0,
        CHECK (expires_at > created_at),
        CHECK ((status = 'RESOLVED') = (winning_outcome IS NOT NULL AND resolved_at IS NOT NULL)),
        FOREIGN KEY (id, winning_outcome) REFERENCES market_outcomes (market_id, idx)
      );
      CREATE INDEX idx_markets_status_expiry ON markets (status, expires_at);
      CREATE INDEX idx_markets_creator ON markets (creator_id, created_at);
      CREATE INDEX idx_markets_sync ON markets (sync_version, synced_version);

      CREATE TABLE market_outcomes (
        market_id INTEGER NOT NULL REFERENCES markets (id),
        idx       INTEGER NOT NULL CHECK (idx >= 0),
        label     TEXT NOT NULL,
        PRIMARY KEY (market_id, idx)
      );

      CREATE TABLE bets (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id       INTEGER NOT NULL REFERENCES markets (id),
        user_id         TEXT NOT NULL REFERENCES users (id),
        outcome         INTEGER NOT NULL,
        stake           INTEGER NOT NULL CHECK (stake > 0),
        status          TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'REFUNDED')),
        payout          INTEGER CHECK (payout IS NULL OR payout >= 0),
        settled_at      INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL,
        CHECK ((status = 'ACTIVE') = (settled_at IS NULL)),
        FOREIGN KEY (market_id, outcome) REFERENCES market_outcomes (market_id, idx)
      );
      CREATE INDEX idx_bets_market ON bets (market_id, status);
      CREATE INDEX idx_bets_user ON bets (user_id, created_at DESC);

      CREATE TABLE transactions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL REFERENCES users (id),
        amount          INTEGER NOT NULL CHECK (amount <> 0),
        balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
        type            TEXT NOT NULL CHECK (type IN (
                          'INITIAL_BALANCE', 'DAILY_REWARD', 'BET_STAKE', 'BET_PAYOUT',
                          'BET_REFUND', 'ADMIN_GRANT', 'ADMIN_REMOVE')),
        market_id       INTEGER REFERENCES markets (id),
        bet_id          INTEGER REFERENCES bets (id),
        idempotency_key TEXT NOT NULL UNIQUE,
        reason          TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_transactions_user ON transactions (user_id, created_at DESC);

      CREATE TABLE settlements (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id       INTEGER NOT NULL UNIQUE REFERENCES markets (id),
        kind            TEXT NOT NULL CHECK (kind IN ('RESOLVED', 'CANCELLED')),
        winning_outcome INTEGER,
        pools_json      TEXT NOT NULL,
        total_pool      INTEGER NOT NULL CHECK (total_pool >= 0),
        total_paid      INTEGER NOT NULL CHECK (total_paid >= 0),
        winner_count    INTEGER NOT NULL DEFAULT 0,
        refunded        INTEGER NOT NULL DEFAULT 0,
        settled_by      TEXT,
        settled_at      INTEGER NOT NULL,
        CHECK (total_paid = total_pool)
      );

      CREATE TABLE settlement_payouts (
        market_id INTEGER NOT NULL REFERENCES settlements (market_id),
        user_id   TEXT NOT NULL REFERENCES users (id),
        staked    INTEGER NOT NULL CHECK (staked >= 0),
        paid      INTEGER NOT NULL CHECK (paid >= 0),
        PRIMARY KEY (market_id, user_id)
      );

      CREATE TABLE audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id    TEXT NOT NULL,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        reason      TEXT,
        metadata    TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);

      CREATE TABLE daily_distributions (
        reward_date  TEXT PRIMARY KEY,
        status       TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
        amount       INTEGER NOT NULL CHECK (amount > 0),
        member_count INTEGER,
        recipients   INTEGER NOT NULL DEFAULT 0,
        total_points INTEGER NOT NULL DEFAULT 0,
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        started_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE daily_rewards (
        user_id        TEXT NOT NULL REFERENCES users (id),
        reward_date    TEXT NOT NULL REFERENCES daily_distributions (reward_date),
        amount         INTEGER NOT NULL CHECK (amount > 0),
        transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions (id),
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (user_id, reward_date)
      );
      CREATE INDEX idx_daily_rewards_date ON daily_rewards (reward_date);

      CREATE TABLE pending_confirmations (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE notifications (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key      TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,
        market_id       INTEGER REFERENCES markets (id),
        payload         TEXT,
        status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        sent_at         INTEGER
      );
      CREATE INDEX idx_notifications_pending ON notifications (status, next_attempt_at);
    `,
  },
  {
    version: 2,
    name: 'key-value metadata',
    up: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
