'use strict';

const { UserService } = require('./userService');
const { MarketService } = require('./marketService');
const { BettingService } = require('./bettingService');
const { SettlementService } = require('./settlementService');
const { DailyRewardService } = require('./dailyRewardService');
const { StatsService } = require('./statsService');
const { AuditService, OutboxService, ConfirmationService } = require('./supportServices');

/** Wires all services around one database handle. `clock` is injectable for tests. */
function createServices(db, config, clock = Date.now) {
  const audit = new AuditService(db, clock);
  const outbox = new OutboxService(db, clock);
  const confirmations = new ConfirmationService(db, clock);
  const users = new UserService(db, config, clock);
  const markets = new MarketService(db, config, users, outbox, clock);
  const betting = new BettingService(db, config, users, markets, clock);
  const settlement = new SettlementService(db, config, users, markets, outbox, audit, clock);
  const daily = new DailyRewardService(db, config, users, audit, clock);
  const stats = new StatsService(db);
  return { db, config, clock, audit, outbox, confirmations, users, markets, betting, settlement, daily, stats };
}

module.exports = { createServices };
