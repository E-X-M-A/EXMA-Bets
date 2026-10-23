'use strict';

const logger = require('../utils/logger');
const { msUntilNextLocalMidnight } = require('../utils/time');

const DEFAULT_INTERVALS = {
  markets: 15_000, // close expired markets, refresh stale embeds, deliver notifications
  dailyCheck: 5 * 60_000, // safety net for the midnight timer (sleep, clock jumps, failed runs)
  purge: 60 * 60_000,
};

/**
 * Periodic jobs. Every job is idempotent and driven by database state, so running
 * one late, twice, or after a crash is harmless:
 *  - market expiry: OPEN markets past `expires_at` -> AWAITING_RESOLUTION
 *  - embed sync + outbox delivery (creator reminders, result announcements)
 *  - daily rewards at 00:00 in the configured time zone, with catch-up for missed days
 */
class Scheduler {
  constructor({ services, publisher, notifier, memberSource, intervals = {} }) {
    this.services = services;
    this.publisher = publisher;
    this.notifier = notifier;
    this.memberSource = memberSource;
    this.intervals = { ...DEFAULT_INTERVALS, ...intervals };
    this.timers = [];
    this.midnightTimer = null;
    this.marketsRun = null;
    this.dailyRun = null;
    this.stopped = false;
    this.lastDailyError = null;
  }

  /** Startup recovery followed by the recurring timers. */
  async start() {
    this.stopped = false;
    await this.reconcile();
    if (this.stopped) return;
    this.timers.push(setInterval(() => this.tickMarkets(), this.intervals.markets));
    this.timers.push(setInterval(() => this.runDaily(), this.intervals.dailyCheck));
    this.timers.push(setInterval(() => this.safe('purge', () => this.services.confirmations.purgeExpired()), this.intervals.purge));
    this.scheduleMidnight();
  }

  /** Brings everything up to date after (re)start: expired markets, stale embeds, missed rewards. */
  async reconcile() {
    await this.tickMarkets();
    await this.runDaily();
  }

  tickMarkets() {
    if (!this.marketsRun) {
      this.marketsRun = (async () => {
        await this.safe('close expired markets', () => {
          const closed = this.services.markets.closeExpiredMarkets();
          if (closed.length) logger.info(`Closed betting on market(s): ${closed.map((id) => `#${id}`).join(', ')}`);
        });
        if (this.publisher) await this.safe('sync market embeds', () => this.publisher.syncAll());
        if (this.notifier) await this.safe('deliver notifications', () => this.notifier.dispatch());
      })().finally(() => {
        this.marketsRun = null;
      });
    }
    return this.marketsRun;
  }

  scheduleMidnight() {
    if (this.stopped) return;
    clearTimeout(this.midnightTimer);
    const { timezone } = this.services.config;
    // A second of slack so the new local date is definitely in effect.
    const delay = msUntilNextLocalMidnight(this.services.clock(), timezone) + 1000;
    this.midnightTimer = setTimeout(async () => {
      await this.runDaily();
      this.scheduleMidnight();
    }, delay);
    logger.debug(`Next daily distribution in ${Math.round(delay / 60_000)} min`);
  }

  /** Distributes every pending day's reward (today, plus missed days after downtime). */
  runDaily() {
    if (!this.dailyRun) {
      this.dailyRun = this.distributePending().finally(() => {
        this.dailyRun = null;
      });
    }
    return this.dailyRun;
  }

  async distributePending() {
    const { daily } = this.services;
    const dates = daily.pendingDates();
    if (!dates.length) return [];

    let members;
    try {
      members = await this.memberSource();
    } catch (err) {
      this.lastDailyError = { at: this.services.clock(), message: `Fetching server members failed: ${err.message}` };
      logger.error(`Daily distribution: could not fetch members (${err.message}). Will retry.`);
      for (const date of dates) daily.recordFailure(date, `Fetching server members failed: ${err.message}`);
      return [];
    }

    const results = [];
    for (const date of dates) {
      if (this.stopped) break;
      try {
        const result = await daily.distribute(date, members);
        results.push(result);
        logger.info(
          `Daily distribution ${date}: ${result.paidNow ?? 0} paid now, ${result.recipients} total recipients, ${result.totalPoints} pts`,
        );
      } catch (err) {
        this.lastDailyError = { at: this.services.clock(), message: `${date}: ${err.message}` };
        logger.error(`Daily distribution ${date} failed; it will resume on the next check.`, err);
        break;
      }
    }
    return results;
  }

  async safe(label, fn) {
    try {
      return await fn();
    } catch (err) {
      logger.error(`Scheduler job "${label}" failed:`, err);
      return undefined;
    }
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.midnightTimer);
    await Promise.allSettled([this.marketsRun, this.dailyRun].filter(Boolean));
  }
}

module.exports = { Scheduler };
