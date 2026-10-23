'use strict';

const logger = require('../utils/logger');
const { withRetry } = require('./retry');
const { getPostableChannel } = require('./channels');
const { marketMessage } = require('./views');

/**
 * Keeps the published market messages in sync with the database.
 *
 * Every state change bumps `markets.sync_version`; this worker renders the current
 * state and records the version it published in `synced_version`. Updates for the
 * same market are serialised and coalesced (a burst of bets causes at most one
 * extra edit), and anything that fails is retried by the scheduler's periodic sweep.
 * Discord failures never touch committed betting/settlement data.
 */
class MarketPublisher {
  constructor(client, services, config) {
    this.client = client;
    this.services = services;
    this.config = config;
    this.inflight = new Map();
    this.again = new Set();
  }

  /** Schedules a sync for `marketId` and returns a promise for its completion (never rejects). */
  sync(marketId) {
    if (this.inflight.has(marketId)) {
      this.again.add(marketId);
      return this.inflight.get(marketId);
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(marketId);
          await this.syncOnce(marketId);
        } while (this.again.has(marketId));
        return true;
      } catch (err) {
        logger.warn(`Could not sync market #${marketId}: ${err.message ?? err}`);
        return false;
      } finally {
        this.inflight.delete(marketId);
      }
    })();
    this.inflight.set(marketId, run);
    return run;
  }

  async syncOnce(marketId) {
    const market = this.services.markets.getMarket(marketId);
    if (!market || market.synced_version >= market.sync_version) return;
    const version = market.sync_version;
    const settlement = market.status === 'RESOLVED' ? this.services.settlement.getSettlement(market.id) : null;
    const payload = marketMessage(market, { now: this.services.clock(), settlement });

    if (market.announcement_message_id) {
      const { channel, problem } = await getPostableChannel(this.client, this.config.guildId, market.announcement_channel_id);
      if (!channel) throw new Error(problem);
      try {
        await withRetry(() => channel.messages.edit(market.announcement_message_id, payload), {
          label: `edit market #${market.id}`,
        });
      } catch (err) {
        if (err.code !== 10008) throw err; // 10008 = Unknown Message (deleted)
        if (market.status !== 'OPEN') {
          logger.warn(`Announcement for market #${market.id} was deleted; not reposting a closed market.`);
          this.services.markets.markSynced(market.id, version);
          return;
        }
        logger.warn(`Announcement for market #${market.id} was deleted; reposting.`);
        await this.publish(market, payload);
      }
    } else {
      await this.publish(market, payload);
    }
    this.services.markets.markSynced(market.id, version);
  }

  async publish(market, payload) {
    const channelId = this.config.announcementChannelId;
    const { channel, problem } = await getPostableChannel(this.client, this.config.guildId, channelId);
    if (!channel || problem) throw new Error(`cannot publish market #${market.id}: ${problem}`);
    const message = await withRetry(() => channel.send(payload), { label: `publish market #${market.id}` });
    this.services.markets.setAnnouncementMessage(market.id, channel.id, message.id);
    logger.info(`Published market #${market.id} as message ${message.id}`);
    return message;
  }

  /** Re-syncs every market whose message is stale (used on startup and periodically). */
  async syncAll() {
    const ids = this.services.markets.marketsNeedingSync(50);
    for (const id of ids) await this.sync(id);
    return ids.length;
  }
}

module.exports = { MarketPublisher };
