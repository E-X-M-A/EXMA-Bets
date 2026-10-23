'use strict';

const { tx } = require('../database');
const { UserError } = require('../utils/errors');
const { discordTimestamp } = require('../utils/time');
const { STATUS } = require('./marketService');

class BettingService {
  constructor(db, config, users, markets, clock = Date.now) {
    this.db = db;
    this.config = config;
    this.users = users;
    this.markets = markets;
    this.clock = clock;
    this.stmts = {
      byKey: db.prepare('SELECT * FROM bets WHERE idempotency_key = ?'),
      insert: db.prepare(`INSERT INTO bets (market_id, user_id, outcome, stake, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
    };
  }

  /**
   * Parses a user-entered stake ("250", "1,000", "max"/"all"). Returns an integer or throws.
   */
  parseStake(input, balance) {
    const text = String(input ?? '').trim().toLowerCase().replace(/[,_' ]/g, '');
    if (text === 'max' || text === 'all') return balance;
    if (!/^\d{1,13}$/.test(text)) throw new UserError('The stake must be a whole number of points.', 'INVALID_STAKE');
    return Number(text);
  }

  /** Throws a UserError explaining why `market` cannot take bets right now. */
  assertOpen(market, now) {
    if (market.status === STATUS.RESOLVED) throw new UserError(`Market #${market.id} is already resolved.`, 'MARKET_CLOSED');
    if (market.status === STATUS.CANCELLED) throw new UserError(`Market #${market.id} was cancelled.`, 'MARKET_CLOSED');
    if (market.status !== STATUS.OPEN || now >= market.expires_at) {
      throw new UserError(
        `Betting on market #${market.id} closed ${discordTimestamp(market.expires_at, 'R')}.`,
        'MARKET_CLOSED',
      );
    }
  }

  validateStake(stake, balance) {
    if (!Number.isSafeInteger(stake) || stake <= 0) {
      throw new UserError('The stake must be a positive whole number of points.', 'INVALID_STAKE');
    }
    if (stake < this.config.minBet) {
      throw new UserError(`The minimum bet is ${this.config.minBet} points.`, 'STAKE_TOO_SMALL');
    }
    if (stake > balance) {
      throw new UserError(
        `Insufficient balance: you have ${balance.toLocaleString('en-US')} points.`,
        'INSUFFICIENT_BALANCE',
      );
    }
  }

  /**
   * Places a bet atomically: re-validates market state, expiry, outcome and balance,
   * debits the stake and inserts the bet in one transaction. `idempotencyKey` is
   * unique per bet attempt; replaying it returns the original bet without charging.
   */
  placeBet({ marketId, userId, username, outcome, stake, idempotencyKey }) {
    if (!idempotencyKey) throw new Error('idempotencyKey is required');
    return tx(this.db, () => {
      const existing = this.stmts.byKey.get(idempotencyKey);
      if (existing) {
        return {
          duplicate: true,
          bet: existing,
          balance: this.users.getUser(userId).balance,
          market: this.markets.getMarket(existing.market_id),
        };
      }
      const user = this.users.ensureUser(userId, username);
      const market = this.markets.requireMarket(marketId);
      const now = this.clock();
      this.assertOpen(market, now);
      const outcomeIdx = this.markets.matchOutcome(market, outcome);
      this.validateStake(stake, user.balance);

      const info = this.stmts.insert.run(market.id, userId, outcomeIdx, stake, idempotencyKey, now);
      const betId = Number(info.lastInsertRowid);
      const { balance } = this.users.applyTransaction(userId, -stake, {
        type: 'BET_STAKE',
        key: `stake:${betId}`,
        marketId: market.id,
        betId,
      });
      this.markets.touch(market.id);
      return {
        duplicate: false,
        bet: this.stmts.byKey.get(idempotencyKey),
        balance,
        market: this.markets.getMarket(market.id),
      };
    });
  }
}

module.exports = { BettingService };
