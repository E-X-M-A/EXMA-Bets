'use strict';

const { tx } = require('../database');
const { UserError } = require('../utils/errors');
const { discordTimestamp } = require('../utils/time');
const { computeSettlement } = require('./marketMath');
const { STATUS } = require('./marketService');

/**
 * Resolution, cancellation and payouts. Each market can be settled exactly once:
 * the settlements table has a UNIQUE(market_id) constraint, each bet only moves
 * from ACTIVE once, and every credit carries a per-bet idempotency key — all inside
 * one transaction, so a crash leaves either everything or nothing applied.
 */
class SettlementService {
  constructor(db, config, users, markets, outbox, audit, clock = Date.now) {
    this.db = db;
    this.config = config;
    this.users = users;
    this.markets = markets;
    this.outbox = outbox;
    this.audit = audit;
    this.clock = clock;
    this.stmts = {
      settlement: db.prepare('SELECT * FROM settlements WHERE market_id = ?'),
      activeBets: db.prepare("SELECT * FROM bets WHERE market_id = ? AND status = 'ACTIVE' ORDER BY id"),
      allBets: db.prepare('SELECT outcome, stake FROM bets WHERE market_id = ?'),
      insertSettlement: db.prepare(`INSERT INTO settlements
        (market_id, kind, winning_outcome, pools_json, total_pool, total_paid, winner_count, refunded, settled_by, settled_at)
        VALUES (@marketId, @kind, @winningOutcome, @pools, @totalPool, @totalPaid, @winnerCount, @refunded, @settledBy, @now)`),
      insertPayout: db.prepare(`INSERT INTO settlement_payouts (market_id, user_id, staked, paid) VALUES (?, ?, ?, ?)
        ON CONFLICT (market_id, user_id) DO UPDATE SET staked = staked + excluded.staked, paid = paid + excluded.paid`),
      settleBet: db.prepare(
        "UPDATE bets SET status = ?, payout = ?, settled_at = ? WHERE id = ? AND status = 'ACTIVE'",
      ),
      resolveMarket: db.prepare(`UPDATE markets SET status = 'RESOLVED', winning_outcome = ?, resolved_at = ?,
        resolver_id = ?, resolved_by_admin = ?, closed_at = COALESCE(closed_at, ?), sync_version = sync_version + 1
        WHERE id = ? AND status IN ('OPEN', 'AWAITING_RESOLUTION')`),
      cancelMarket: db.prepare(`UPDATE markets SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
        cancel_reason = ?, closed_at = COALESCE(closed_at, ?), sync_version = sync_version + 1
        WHERE id = ? AND status IN ('OPEN', 'AWAITING_RESOLUTION')`),
      payouts: db.prepare('SELECT * FROM settlement_payouts WHERE market_id = ? ORDER BY paid DESC, user_id'),
    };
  }

  /**
   * Checks whether `actorId` may resolve `market` right now (without changing anything).
   * Returns the outcome index.
   */
  validateResolution(market, { outcome, actorId, isAdmin }) {
    if (market.status === STATUS.RESOLVED) throw new UserError(`Market #${market.id} is already resolved.`, 'ALREADY_SETTLED');
    if (market.status === STATUS.CANCELLED) throw new UserError(`Market #${market.id} was cancelled.`, 'ALREADY_SETTLED');
    if (!isAdmin && market.creator_id !== actorId) {
      throw new UserError('Only the creator of this market can resolve it.', 'NOT_CREATOR');
    }
    if (this.clock() < market.expires_at) {
      throw new UserError(
        `Market #${market.id} is still open. It can be resolved after it closes ${discordTimestamp(market.expires_at, 'R')}.`,
        'NOT_EXPIRED',
      );
    }
    return this.markets.matchOutcome(market, outcome);
  }

  /** Read-only preview of what resolving to `winningOutcome` would pay out. */
  previewResolution(market, winningOutcome) {
    const bets = this.stmts.activeBets.all(market.id).map((b) => ({ id: b.id, userId: b.user_id, outcome: b.outcome, stake: b.stake }));
    const result = computeSettlement(bets, winningOutcome, market.outcomes.length);
    const winners = new Set(result.results.filter((r) => r.status === 'WON').map((r) => r.userId));
    return { mode: result.mode, totalPool: result.totalPool, pools: result.pools, winnerCount: winners.size, betCount: bets.length };
  }

  /** Resolves a market and pays out winners. Returns a settlement summary. */
  resolveMarket({ marketId, outcome, actorId, isAdmin = false, reason = null }) {
    if (isAdmin && !cleanReason(reason)) throw new UserError('A reason is required.', 'REASON_REQUIRED');
    return tx(this.db, () => {
      const market = this.markets.requireMarket(marketId);
      const winningOutcome = this.validateResolution(market, { outcome, actorId, isAdmin });
      const now = this.clock();

      const bets = this.stmts.activeBets.all(market.id).map((b) => ({
        id: b.id,
        userId: b.user_id,
        outcome: b.outcome,
        stake: b.stake,
      }));
      const result = computeSettlement(bets, winningOutcome, market.outcomes.length);
      const summary = this.applySettlement(market, {
        kind: 'RESOLVED',
        winningOutcome,
        result,
        settledBy: actorId,
        now,
      });

      if (this.stmts.resolveMarket.run(winningOutcome, now, actorId, isAdmin ? 1 : 0, now, market.id).changes !== 1) {
        throw new UserError(`Market #${market.id} can no longer be resolved.`, 'ALREADY_SETTLED');
      }
      this.audit.log({
        actorId,
        action: isAdmin ? 'ADMIN_MARKET_RESOLVE' : 'MARKET_RESOLVE',
        targetType: 'market',
        targetId: market.id,
        reason: isAdmin ? cleanReason(reason) : null,
        metadata: { winningOutcome, label: market.outcomes[winningOutcome].label, mode: result.mode, pools: result.pools },
      });
      this.outbox.enqueue(`resolved:${market.id}`, 'MARKET_RESOLVED', market.id);
      this.enqueueBettorResults(market.id);
      return { ...summary, market: this.markets.getMarket(market.id) };
    });
  }

  /** Administrator cancellation: refunds every unsettled stake. */
  cancelMarket({ marketId, actorId, reason }) {
    const why = cleanReason(reason);
    if (!why) throw new UserError('A reason is required.', 'REASON_REQUIRED');
    return tx(this.db, () => {
      const market = this.markets.requireMarket(marketId);
      if (market.status === STATUS.RESOLVED || market.status === STATUS.CANCELLED) {
        throw new UserError(`Market #${market.id} is already ${market.status.toLowerCase()}.`, 'ALREADY_SETTLED');
      }
      const now = this.clock();
      const bets = this.stmts.activeBets.all(market.id);
      const pools = market.outcomes.map(() => 0);
      for (const b of bets) pools[b.outcome] += b.stake;
      const result = {
        mode: 'CANCELLED',
        pools,
        totalPool: pools.reduce((a, b) => a + b, 0),
        results: bets.map((b) => ({ betId: b.id, userId: b.user_id, stake: b.stake, status: 'REFUNDED', payout: b.stake })),
      };
      const summary = this.applySettlement(market, { kind: 'CANCELLED', winningOutcome: null, result, settledBy: actorId, now });
      if (this.stmts.cancelMarket.run(now, actorId, why, now, market.id).changes !== 1) {
        throw new UserError(`Market #${market.id} can no longer be cancelled.`, 'ALREADY_SETTLED');
      }
      this.audit.log({
        actorId,
        action: 'ADMIN_MARKET_CANCEL',
        targetType: 'market',
        targetId: market.id,
        reason: why,
        metadata: { refunded: summary.totalPaid, bets: bets.length, previousStatus: market.status },
      });
      this.outbox.enqueue(`cancelled:${market.id}`, 'MARKET_CANCELLED', market.id);
      this.enqueueBettorResults(market.id);
      return { ...summary, market: this.markets.getMarket(market.id) };
    });
  }

  /** Writes the settlement record, bet outcomes, ledger credits and per-user payouts. Must run inside a tx. */
  applySettlement(market, { kind, winningOutcome, result, settledBy, now }) {
    const totalPaid = result.results.reduce((a, r) => a + r.payout, 0);
    if (totalPaid !== result.totalPool) {
      throw new Error(`Settlement for market ${market.id} does not balance: ${totalPaid} != ${result.totalPool}`);
    }
    const winners = new Set(result.results.filter((r) => r.status === 'WON').map((r) => r.userId));
    try {
      this.stmts.insertSettlement.run({
        marketId: market.id,
        kind,
        winningOutcome,
        pools: JSON.stringify(result.pools),
        totalPool: result.totalPool,
        totalPaid,
        winnerCount: winners.size,
        refunded: result.mode === 'REFUND' || result.mode === 'CANCELLED' ? 1 : 0,
        settledBy,
        now,
      });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new UserError(`Market #${market.id} has already been settled.`, 'ALREADY_SETTLED');
      }
      throw err;
    }

    for (const r of result.results) {
      if (this.stmts.settleBet.run(r.status, r.payout, now, r.betId).changes !== 1) {
        throw new Error(`Bet ${r.betId} was already settled`);
      }
      if (r.payout > 0) {
        const refund = r.status === 'REFUNDED';
        this.users.applyTransaction(r.userId, r.payout, {
          type: refund ? 'BET_REFUND' : 'BET_PAYOUT',
          key: `${refund ? 'refund' : 'payout'}:${r.betId}`,
          marketId: market.id,
          betId: r.betId,
        });
      }
      this.stmts.insertPayout.run(market.id, r.userId, r.stake, r.payout);
    }
    return { mode: result.mode, pools: result.pools, totalPool: result.totalPool, totalPaid, winnerCount: winners.size };
  }

  /** Queues one result DM per bettor (deduplicated per market and user). Must run inside the settlement tx. */
  enqueueBettorResults(marketId) {
    for (const p of this.stmts.payouts.all(marketId)) {
      this.outbox.enqueue(`result:${marketId}:${p.user_id}`, 'BET_RESULT', marketId, { userId: p.user_id });
    }
  }

  getSettlement(marketId) {
    const s = this.stmts.settlement.get(marketId);
    if (!s) return null;
    return { ...s, pools: JSON.parse(s.pools_json), payouts: this.stmts.payouts.all(marketId) };
  }
}

function cleanReason(reason) {
  return String(reason ?? '').trim().slice(0, 500);
}

module.exports = { SettlementService };
