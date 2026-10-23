'use strict';

const { tx } = require('../database');
const { UserError } = require('../utils/errors');
const { parseDuration, formatDuration, MIN_DURATION_MS, MAX_DURATION_MS } = require('../utils/time');
const { marketStats } = require('./marketMath');

const STATUS = Object.freeze({
  OPEN: 'OPEN',
  AWAITING_RESOLUTION: 'AWAITING_RESOLUTION',
  RESOLVED: 'RESOLVED',
  CANCELLED: 'CANCELLED',
});

const LIMITS = Object.freeze({
  questionMin: 5,
  questionMax: 200,
  outcomeMax: 50,
  descriptionMax: 1000,
  // 10 is the most that fits Discord's 5 rows x 5 buttons alongside the resolve buttons.
  minOutcomes: 2,
  maxOutcomes: 10,
  duplicateWindowMs: 2 * 60_000,
});

/** Collapses whitespace and strips characters that would break Discord markdown/mentions. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

class MarketService {
  constructor(db, config, users, outbox, clock = Date.now) {
    this.db = db;
    this.config = config;
    this.users = users;
    this.outbox = outbox;
    this.clock = clock;
    this.stmts = {
      byKey: db.prepare('SELECT id FROM markets WHERE creation_key = ?'),
      recentSame: db.prepare(`SELECT id FROM markets WHERE creator_id = ? AND lower(question) = lower(?)
        AND status = 'OPEN' AND created_at > ?`),
      insert: db.prepare(`INSERT INTO markets (creator_id, question, description, status, created_at, expires_at,
        announcement_channel_id, creation_key) VALUES (@creatorId, @question, @description, 'OPEN', @now, @expiresAt,
        @channelId, @creationKey)`),
      insertOutcome: db.prepare('INSERT INTO market_outcomes (market_id, idx, label) VALUES (?, ?, ?)'),
      get: db.prepare('SELECT * FROM markets WHERE id = ?'),
      outcomes: db.prepare('SELECT idx, label FROM market_outcomes WHERE market_id = ? ORDER BY idx'),
      pools: db.prepare(`SELECT outcome, SUM(stake) AS pool, COUNT(DISTINCT user_id) AS bettors
        FROM bets WHERE market_id = ? GROUP BY outcome`),
      participants: db.prepare('SELECT COUNT(DISTINCT user_id) FROM bets WHERE market_id = ?').pluck(),
      userBets: db.prepare('SELECT * FROM bets WHERE market_id = ? AND user_id = ? ORDER BY id'),
      bettorStakes: db.prepare(`SELECT user_id, outcome, SUM(stake) AS stake, COUNT(*) AS bets, MIN(id) AS first_bet
        FROM bets WHERE market_id = ? GROUP BY user_id, outcome`),
      expiredOpen: db.prepare("SELECT id FROM markets WHERE status = 'OPEN' AND expires_at <= ? ORDER BY expires_at"),
      close: db.prepare(`UPDATE markets SET status = 'AWAITING_RESOLUTION', closed_at = ?, sync_version = sync_version + 1
        WHERE id = ? AND status = 'OPEN' AND expires_at <= ?`),
      setMessage: db.prepare(
        'UPDATE markets SET announcement_channel_id = ?, announcement_message_id = ? WHERE id = ?',
      ),
      bump: db.prepare('UPDATE markets SET sync_version = sync_version + 1 WHERE id = ?'),
      markSynced: db.prepare('UPDATE markets SET synced_version = max(synced_version, ?) WHERE id = ?'),
      needsSync: db.prepare('SELECT id FROM markets WHERE synced_version < sync_version ORDER BY id LIMIT ?').pluck(),
      count: db.prepare('SELECT COUNT(*) FROM markets WHERE status = ?').pluck(),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?').pluck(),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      bumpPublished: db.prepare(
        'UPDATE markets SET sync_version = sync_version + 1 WHERE announcement_message_id IS NOT NULL',
      ),
      list: db.prepare(`SELECT id FROM markets WHERE status = ?
        ORDER BY CASE WHEN status = 'OPEN' THEN expires_at END ASC, id DESC LIMIT ? OFFSET ?`),
      search: db.prepare(`SELECT id, question, status, expires_at FROM markets
        WHERE status IN (SELECT value FROM json_each(@statuses))
          AND (@creatorId IS NULL OR creator_id = @creatorId)
          AND (CAST(id AS TEXT) LIKE @prefix OR question LIKE @pattern ESCAPE '\\')
        ORDER BY id DESC LIMIT 25`),
      awaiting: db.prepare(`SELECT id FROM markets
        WHERE status = 'AWAITING_RESOLUTION' OR (status = 'OPEN' AND expires_at <= ?) ORDER BY expires_at LIMIT ?`),
    };
  }

  /**
   * Validates input and creates a market. `creationKey` (the Discord interaction id)
   * makes creation idempotent: replaying the same interaction returns the same market.
   */
  createMarket({ creatorId, creatorName, question, outcomes, duration, description, creationKey }) {
    if (!creationKey) throw new Error('creationKey is required');
    const q = cleanText(question);
    const desc = cleanText(description ?? '').replace(/\n{3,}/g, '\n\n') || null;
    const labels = (outcomes ?? []).map(cleanText);

    if (q.length < LIMITS.questionMin || q.length > LIMITS.questionMax) {
      throw new UserError(`The question must be ${LIMITS.questionMin}-${LIMITS.questionMax} characters long.`);
    }
    if (labels.length < LIMITS.minOutcomes || labels.length > LIMITS.maxOutcomes) {
      throw new UserError(`Markets need between ${LIMITS.minOutcomes} and ${LIMITS.maxOutcomes} outcomes.`);
    }
    for (const label of labels) {
      if (!label || label.length > LIMITS.outcomeMax || label.includes('\n')) {
        throw new UserError(`Each outcome must be a single line of 1-${LIMITS.outcomeMax} characters.`);
      }
    }
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      throw new UserError('Outcomes must be different from each other.');
    }
    if (desc && desc.length > LIMITS.descriptionMax) {
      throw new UserError(`The description can be at most ${LIMITS.descriptionMax} characters.`);
    }
    const durationMs = typeof duration === 'number' ? duration : parseDuration(duration);
    if (!durationMs) throw new UserError('Invalid duration. Use formats like `30m`, `6h`, `2d`, `7d` or `1d12h`.');
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      throw new UserError(
        `Duration must be between ${formatDuration(MIN_DURATION_MS)} and ${formatDuration(MAX_DURATION_MS)}.`,
      );
    }

    return tx(this.db, () => {
      const existing = this.stmts.byKey.get(creationKey);
      if (existing) return { market: this.getMarket(existing.id), duplicate: true };

      this.users.ensureUser(creatorId, creatorName);
      const now = this.clock();
      if (this.stmts.recentSame.get(creatorId, q, now - LIMITS.duplicateWindowMs)) {
        throw new UserError('You just created a market with this question. Duplicate markets are not allowed.');
      }
      const info = this.stmts.insert.run({
        creatorId,
        question: q,
        description: desc,
        now,
        expiresAt: now + durationMs,
        channelId: this.config.announcementChannelId || null,
        creationKey,
      });
      const marketId = Number(info.lastInsertRowid);
      labels.forEach((label, idx) => this.stmts.insertOutcome.run(marketId, idx, label));
      return { market: this.getMarket(marketId), duplicate: false };
    });
  }

  /** Full market view: row, outcomes with pools/probabilities, totals. Null if unknown. */
  getMarket(marketId) {
    const id = Number(marketId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = this.stmts.get.get(id);
    if (!row) return null;
    const outcomes = this.stmts.outcomes.all(id).map((o) => ({ idx: o.idx, label: o.label, pool: 0, bettors: 0 }));
    for (const p of this.stmts.pools.all(id)) {
      outcomes[p.outcome].pool = p.pool;
      outcomes[p.outcome].bettors = p.bettors;
    }
    const stats = marketStats(outcomes.map((o) => o.pool));
    outcomes.forEach((o, i) => Object.assign(o, { probability: stats[i].probability, multiplier: stats[i].multiplier }));
    return {
      ...row,
      outcomes,
      totalPool: outcomes.reduce((a, o) => a + o.pool, 0),
      participants: this.stmts.participants.get(id),
    };
  }

  requireMarket(marketId) {
    const market = this.getMarket(marketId);
    if (!market) throw new UserError(`Market #${marketId} does not exist.`, 'MARKET_NOT_FOUND');
    return market;
  }

  /** True when bets are accepted right now (status AND clock are checked). */
  isAcceptingBets(market, now = this.clock()) {
    return market.status === STATUS.OPEN && now < market.expires_at;
  }

  /**
   * Resolves an outcome given by index, letter (A/B) or label (case-insensitive).
   * Returns the outcome index or throws.
   */
  matchOutcome(market, input) {
    if (Number.isInteger(input)) {
      if (market.outcomes[input]) return input;
    } else {
      const text = cleanText(input).toLowerCase();
      const byLabel = market.outcomes.find((o) => o.label.toLowerCase() === text);
      if (byLabel) return byLabel.idx;
      if (/^[a-z]$/.test(text)) {
        const idx = text.charCodeAt(0) - 97;
        if (market.outcomes[idx]) return idx;
      }
      if (/^\d+$/.test(text) && market.outcomes[Number(text)]) return Number(text);
    }
    const valid = market.outcomes.map((o) => `\`${o.label}\``).join(', ');
    throw new UserError(`Unknown outcome. Valid outcomes for market #${market.id}: ${valid}.`, 'INVALID_OUTCOME');
  }

  userBets(marketId, userId) {
    return this.stmts.userBets.all(marketId, userId);
  }

  /**
   * Everyone who bet on a market: `{ userId, stakes: [per outcome], total, bets }`,
   * biggest total first (ties: earliest first bet, then user id).
   */
  bettors(market) {
    const byUser = new Map();
    for (const r of this.stmts.bettorStakes.all(market.id)) {
      if (!byUser.has(r.user_id)) {
        byUser.set(r.user_id, { userId: r.user_id, stakes: market.outcomes.map(() => 0), total: 0, bets: 0, firstBet: r.first_bet });
      }
      const b = byUser.get(r.user_id);
      b.stakes[r.outcome] += r.stake;
      b.total += r.stake;
      b.bets += r.bets;
      b.firstBet = Math.min(b.firstBet, r.first_bet);
    }
    return [...byUser.values()].sort((a, b) => b.total - a.total || a.firstBet - b.firstBet || a.userId.localeCompare(b.userId));
  }

  /**
   * Moves every OPEN market whose expiry has passed to AWAITING_RESOLUTION and
   * queues one creator notification per market. Idempotent and safe after downtime.
   */
  closeExpiredMarkets() {
    const now = this.clock();
    const closed = [];
    for (const { id } of this.stmts.expiredOpen.all(now)) {
      tx(this.db, () => {
        if (this.stmts.close.run(now, id, now).changes !== 1) return;
        const market = this.stmts.get.get(id);
        this.outbox.enqueue(`expired:${id}`, 'MARKET_EXPIRED', id, { creatorId: market.creator_id });
        closed.push(id);
      });
    }
    return closed;
  }

  setAnnouncementMessage(marketId, channelId, messageId) {
    this.stmts.setMessage.run(channelId, messageId, marketId);
  }

  /**
   * If the message layout changed since the last run, flags every published market
   * message for re-rendering (the sync worker then edits them in the background).
   * Returns the number of messages queued.
   */
  refreshLayout(layoutVersion) {
    return tx(this.db, () => {
      if (this.stmts.getMeta.get('market_layout_version') === String(layoutVersion)) return 0;
      const queued = this.stmts.bumpPublished.run().changes;
      this.stmts.setMeta.run('market_layout_version', String(layoutVersion));
      return queued;
    });
  }

  /** Flags the published embed as stale so the sync worker re-renders it. */
  touch(marketId) {
    this.stmts.bump.run(marketId);
  }

  markSynced(marketId, version) {
    this.stmts.markSynced.run(version, marketId);
  }

  marketsNeedingSync(limit = 25) {
    return this.stmts.needsSync.all(limit);
  }

  listMarkets(status, page, pageSize) {
    const total = this.stmts.count.get(status);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), pages);
    const ids = this.stmts.list.all(status, pageSize, (current - 1) * pageSize).map((r) => r.id);
    return { markets: ids.map((id) => this.getMarket(id)), page: current, pages, total };
  }

  /** Autocomplete helper: markets in `statuses` whose id or question matches `query`. */
  searchMarkets(query, { statuses, creatorId = null }) {
    const q = String(query ?? '').replace(/^#/, '').trim().slice(0, 100);
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.stmts.search.all({
      statuses: JSON.stringify(statuses),
      creatorId,
      prefix: /^\d+$/.test(q) ? `${q}%` : '',
      pattern: `%${escaped}%`,
    });
  }

  /** Markets past their expiry that still await a result (oldest first). */
  listAwaitingResolution(limit = 25) {
    return this.stmts.awaiting.all(this.clock(), limit).map((r) => this.getMarket(r.id));
  }
}

module.exports = { MarketService, STATUS, LIMITS, cleanText };
