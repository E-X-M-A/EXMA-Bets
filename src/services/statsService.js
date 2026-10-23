'use strict';

/** Read-only queries for leaderboards, profiles, history and admin statistics. */

const LEADERBOARD_TYPES = Object.freeze({
  balance: {
    label: 'Balance',
    unit: 'pts',
    sql: 'SELECT id AS user_id, username, balance AS value FROM users',
  },
  wagered: {
    label: 'Total wagered',
    unit: 'pts',
    sql: `SELECT u.id AS user_id, u.username, SUM(b.stake) AS value
          FROM bets b JOIN users u ON u.id = b.user_id GROUP BY u.id`,
  },
  profit: {
    label: 'Net profit/loss',
    unit: 'pts',
    sql: `SELECT u.id AS user_id, u.username, SUM(b.payout - b.stake) AS value
          FROM bets b JOIN users u ON u.id = b.user_id
          WHERE b.status IN ('WON', 'LOST') GROUP BY u.id`,
  },
  wins: {
    label: 'Winning bets',
    unit: 'wins',
    sql: `SELECT u.id AS user_id, u.username, COUNT(*) AS value
          FROM bets b JOIN users u ON u.id = b.user_id WHERE b.status = 'WON' GROUP BY u.id`,
  },
});

class StatsService {
  constructor(db) {
    this.db = db;
    this.leaderboardStmts = {};
    for (const [type, def] of Object.entries(LEADERBOARD_TYPES)) {
      // Stable ordering: value, then account age, then id.
      this.leaderboardStmts[type] = {
        page: db.prepare(`SELECT r.*, u.created_at FROM (${def.sql}) r JOIN users u ON u.id = r.user_id
          ORDER BY r.value DESC, u.created_at ASC, r.user_id ASC LIMIT ? OFFSET ?`),
        count: db.prepare(`SELECT COUNT(*) FROM (${def.sql})`).pluck(),
      };
    }
    this.stmts = {
      profile: db.prepare(`SELECT
          COUNT(*) AS bets,
          COALESCE(SUM(stake), 0) AS wagered,
          COALESCE(SUM(status = 'WON'), 0) AS wins,
          COALESCE(SUM(status = 'LOST'), 0) AS losses,
          COALESCE(SUM(status = 'ACTIVE'), 0) AS active,
          COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN stake END), 0) AS at_stake,
          COALESCE(SUM(CASE WHEN status IN ('WON', 'LOST') THEN payout - stake END), 0) AS net
        FROM bets WHERE user_id = ?`),
      marketsCreated: db.prepare(`SELECT COUNT(*) AS created, COALESCE(SUM(status = 'RESOLVED'), 0) AS resolved
        FROM markets WHERE creator_id = ?`),
      rank: db.prepare(`SELECT COUNT(*) + 1 FROM users u, users me WHERE me.id = ?
        AND (u.balance > me.balance OR (u.balance = me.balance AND (u.created_at < me.created_at
        OR (u.created_at = me.created_at AND u.id < me.id))))`).pluck(),
      history: db.prepare(`SELECT b.*, m.question, m.status AS market_status, m.winning_outcome, o.label AS outcome_label
        FROM bets b JOIN markets m ON m.id = b.market_id
        JOIN market_outcomes o ON o.market_id = b.market_id AND o.idx = b.outcome
        WHERE b.user_id = ? ORDER BY b.id DESC LIMIT ?`),
      admin: db.prepare(`SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM markets WHERE status = 'OPEN' AND expires_at > @now) AS open,
          (SELECT COUNT(*) FROM markets WHERE status = 'AWAITING_RESOLUTION'
             OR (status = 'OPEN' AND expires_at <= @now)) AS awaiting,
          (SELECT COUNT(*) FROM markets WHERE status = 'RESOLVED') AS resolved,
          (SELECT COUNT(*) FROM markets WHERE status = 'CANCELLED') AS cancelled,
          (SELECT COUNT(*) FROM bets) AS bets,
          (SELECT COALESCE(SUM(balance), 0) FROM users) AS circulating,
          (SELECT COALESCE(SUM(stake), 0) FROM bets WHERE status = 'ACTIVE') AS locked`),
      ledgerTotal: db.prepare('SELECT COALESCE(SUM(amount), 0) FROM transactions').pluck(),
    };
  }

  leaderboard(type, page, pageSize) {
    const stmts = this.leaderboardStmts[type] ?? this.leaderboardStmts.balance;
    const total = stmts.count.get();
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), pages);
    const offset = (current - 1) * pageSize;
    const rows = stmts.page.all(pageSize, offset).map((r, i) => ({ ...r, rank: offset + i + 1 }));
    return { type: LEADERBOARD_TYPES[type] ? type : 'balance', rows, page: current, pages, total };
  }

  profile(userId) {
    return {
      ...this.stmts.profile.get(userId),
      ...this.stmts.marketsCreated.get(userId),
      rank: this.stmts.rank.get(userId),
    };
  }

  history(userId, limit = 10) {
    return this.stmts.history.all(userId, limit);
  }

  adminStats(now = Date.now()) {
    return { ...this.stmts.admin.get({ now }), ledgerTotal: this.stmts.ledgerTotal.get() };
  }
}

module.exports = { StatsService, LEADERBOARD_TYPES };
