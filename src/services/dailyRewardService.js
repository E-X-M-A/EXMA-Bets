'use strict';

const { tx } = require('../database');
const { localDate, addDays, dateRange } = require('../utils/time');

const BATCH_SIZE = 250;

/**
 * Automatic daily rewards. Each calendar day (in the configured time zone) has one
 * row in daily_distributions; each (user, day) pair has at most one row in
 * daily_rewards thanks to its primary key. Members are processed in batches, each
 * batch in its own transaction, so a crash mid-distribution simply resumes with the
 * members that were not yet paid.
 */
class DailyRewardService {
  constructor(db, config, users, audit, clock = Date.now) {
    this.db = db;
    this.config = config;
    this.users = users;
    this.audit = audit;
    this.clock = clock;
    this.stmts = {
      get: db.prepare('SELECT * FROM daily_distributions WHERE reward_date = ?'),
      first: db.prepare('SELECT MIN(reward_date) FROM daily_distributions').pluck(),
      completed: db.prepare("SELECT reward_date FROM daily_distributions WHERE status = 'COMPLETED' AND reward_date >= ?").pluck(),
      start: db.prepare(`INSERT INTO daily_distributions (reward_date, status, amount, attempts, started_at, updated_at)
        VALUES (@date, 'IN_PROGRESS', @amount, 1, @now, @now)
        ON CONFLICT (reward_date) DO UPDATE SET status = 'IN_PROGRESS', attempts = attempts + 1, updated_at = @now
        WHERE status <> 'COMPLETED'`),
      hasReward: db.prepare('SELECT 1 FROM daily_rewards WHERE user_id = ? AND reward_date = ?').pluck(),
      insertReward: db.prepare(`INSERT INTO daily_rewards (user_id, reward_date, amount, transaction_id, created_at)
        VALUES (?, ?, ?, ?, ?)`),
      touchUser: db.prepare(`UPDATE users SET last_daily_reward_date = ?
        WHERE id = ? AND (last_daily_reward_date IS NULL OR last_daily_reward_date < ?)`),
      progress: db.prepare(`UPDATE daily_distributions SET
        recipients = (SELECT COUNT(*) FROM daily_rewards WHERE reward_date = @date),
        total_points = (SELECT COALESCE(SUM(amount), 0) FROM daily_rewards WHERE reward_date = @date),
        updated_at = @now WHERE reward_date = @date`),
      complete: db.prepare(`UPDATE daily_distributions SET status = 'COMPLETED', member_count = ?, completed_at = ?,
        updated_at = ?, last_error = NULL WHERE reward_date = ?`),
      fail: db.prepare(`INSERT INTO daily_distributions (reward_date, status, amount, attempts, last_error, started_at, updated_at)
        VALUES (@date, 'FAILED', @amount, @inc, @error, @now, @now)
        ON CONFLICT (reward_date) DO UPDATE SET status = 'FAILED', last_error = @error, updated_at = @now,
        attempts = attempts + @inc WHERE status <> 'COMPLETED'`),
      recent: db.prepare('SELECT * FROM daily_distributions ORDER BY reward_date DESC LIMIT ?'),
    };
  }

  get enabled() {
    return this.config.dailyReward > 0;
  }

  today() {
    return localDate(this.clock(), this.config.timezone);
  }

  /**
   * Dates that still need a (complete) distribution, oldest first: every day from
   * the first distribution ever (or today on a fresh install) up to today, limited
   * to the last DAILY_MAX_BACKFILL_DAYS days, minus completed ones.
   */
  pendingDates() {
    if (!this.enabled) return [];
    const today = this.today();
    const windowStart = addDays(today, -(this.config.dailyMaxBackfillDays - 1));
    const first = this.stmts.first.get() ?? today;
    const from = first > windowStart ? first : windowStart;
    const done = new Set(this.stmts.completed.all(from));
    return dateRange(from, today).filter((d) => !done.has(d));
  }

  /**
   * Pays `date`'s reward to every member in `members` ({ id, username }) who has not
   * received it yet. Returns a summary. Throws (after recording the error) if any
   * batch fails; calling again later resumes safely. Yields to the event loop
   * between batches so the bot stays responsive in large servers.
   */
  async distribute(date, members) {
    if (!this.enabled) return { date, skipped: true };
    const amount = this.config.dailyReward;
    const existing = this.stmts.get.get(date);
    if (existing?.status === 'COMPLETED') return { date, alreadyCompleted: true, ...summary(existing) };

    this.stmts.start.run({ date, amount, now: this.clock() });
    let paidNow = 0;
    try {
      for (let i = 0; i < members.length; i += BATCH_SIZE) {
        if (i > 0) await new Promise((resolve) => setImmediate(resolve));
        const batch = members.slice(i, i + BATCH_SIZE);
        paidNow += tx(this.db, () => {
          let paid = 0;
          for (const member of batch) {
            this.users.ensureUser(member.id, member.username ?? null);
            if (this.stmts.hasReward.get(member.id, date)) continue;
            const { transactionId, applied } = this.users.applyTransaction(member.id, amount, {
              type: 'DAILY_REWARD',
              key: `daily:${date}:${member.id}`,
              reason: `Daily reward for ${date}`,
            });
            if (!applied) continue;
            this.stmts.insertReward.run(member.id, date, amount, transactionId, this.clock());
            this.stmts.touchUser.run(date, member.id, date);
            paid++;
          }
          this.stmts.progress.run({ date, now: this.clock() });
          return paid;
        });
      }
    } catch (err) {
      this.recordFailure(date, err, { countAttempt: false });
      throw err;
    }

    const now = this.clock();
    tx(this.db, () => {
      this.stmts.progress.run({ date, now });
      this.stmts.complete.run(members.length, now, now, date);
      const row = this.stmts.get.get(date);
      this.audit.log({
        actorId: 'system',
        action: 'DAILY_DISTRIBUTION_COMPLETE',
        targetType: 'daily_distribution',
        targetId: date,
        metadata: { members: members.length, recipients: row.recipients, totalPoints: row.total_points, attempts: row.attempts },
      });
    });
    return { date, paidNow, ...summary(this.stmts.get.get(date)) };
  }

  /**
   * Marks `date` as FAILED with the error message. `countAttempt` is true when the
   * failure happened before `distribute` started (e.g. the member list could not be fetched).
   */
  recordFailure(date, err, { countAttempt = true } = {}) {
    if (!this.enabled) return;
    this.stmts.fail.run({
      date,
      amount: this.config.dailyReward,
      inc: countAttempt ? 1 : 0,
      error: String(err?.message ?? err).slice(0, 500),
      now: this.clock(),
    });
  }

  getDistribution(date) {
    return this.stmts.get.get(date) ?? null;
  }

  recentDistributions(limit = 5) {
    return this.stmts.recent.all(limit);
  }
}

function summary(row) {
  return { status: row.status, recipients: row.recipients, totalPoints: row.total_points, memberCount: row.member_count };
}

module.exports = { DailyRewardService };
