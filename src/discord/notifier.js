'use strict';

const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const { withRetry } = require('./retry');
const { getPostableChannel } = require('./channels');
const { resultEmbed, messageLink, COLORS } = require('./views');
const { escapeMarkdown } = require('../utils/format');

/**
 * Delivers queued notifications from the outbox table: creator reminders when a
 * market closes, and result/cancellation announcements. Each row is delivered at
 * most once under normal operation (status flips to SENT after delivery) and is
 * retried with backoff when Discord fails.
 */
class Notifier {
  constructor(client, services, config) {
    this.client = client;
    this.services = services;
    this.config = config;
    this.running = null;
  }

  /** Processes due notifications. Concurrent calls share the same run. */
  dispatch() {
    if (!this.running) {
      this.running = this.dispatchDue().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async dispatchDue() {
    let delivered = 0;
    for (const n of this.services.outbox.due(25)) {
      try {
        await this.deliver(n);
        this.services.outbox.markSent(n.id);
        delivered++;
      } catch (err) {
        logger.warn(`Notification ${n.id} (${n.kind}) failed: ${err.message ?? err}`);
        this.services.outbox.markFailed(n.id, err.message ?? err, n.attempts);
      }
    }
    return delivered;
  }

  async deliver(n) {
    const market = this.services.markets.getMarket(n.market_id);
    if (!market) return;
    switch (n.kind) {
      case 'MARKET_EXPIRED':
        return this.notifyCreator(market);
      case 'MARKET_RESOLVED':
      case 'MARKET_CANCELLED':
        return this.announceResult(market);
      default:
        logger.warn(`Unknown notification kind ${n.kind}`);
    }
  }

  async notifyCreator(market) {
    if (market.status !== 'AWAITING_RESOLUTION') return; // resolved/cancelled meanwhile
    const link = market.announcement_message_id
      ? `\n[Open the market](${messageLink(this.config.guildId, market.announcement_channel_id, market.announcement_message_id)})`
      : '';
    const outcomes = market.outcomes.map((o) => `\`${o.label}\``).join(' or ');
    const embed = new EmbedBuilder()
      .setColor(COLORS.CLOSED)
      .setTitle(`⏰ Market #${market.id} has closed`)
      .setDescription(
        `Betting on **${escapeMarkdown(market.question)}** is closed. As the creator, please report the actual outcome ` +
          `(${outcomes}) in <#${this.config.bettingChannelId}>:\n` +
          `\`/market resolve market_id:${market.id} outcome:<outcome>\`\n\n` +
          `Payouts are made as soon as you confirm the result.${link}`,
      );

    try {
      const user = await withRetry(() => this.client.users.fetch(market.creator_id), { label: 'fetch creator' });
      await withRetry(() => user.send({ embeds: [embed] }), { label: `DM creator of #${market.id}` });
      return;
    } catch (err) {
      // 50007: the creator does not accept DMs; 10013: user unknown. Fall back to a channel ping.
      if (![50007, 10013].includes(err.code)) throw err;
    }
    const { channel, problem } = await getPostableChannel(this.client, this.config.guildId, this.config.bettingChannelId);
    if (!channel || problem) throw new Error(`cannot notify creator: ${problem}`);
    await withRetry(
      () =>
        channel.send({
          content: `<@${market.creator_id}>`,
          embeds: [embed],
          allowedMentions: { users: [market.creator_id] },
        }),
      { label: `notify creator of #${market.id}` },
    );
  }

  async announceResult(market) {
    const { channel, problem } = await getPostableChannel(this.client, this.config.guildId, this.config.announcementChannelId);
    if (!channel || problem) throw new Error(`cannot announce result: ${problem}`);
    const settlement = this.services.settlement.getSettlement(market.id);
    const payload = {
      embeds: [resultEmbed(market, settlement, { guildId: this.config.guildId })],
      allowedMentions: { parse: [] },
    };
    if (market.announcement_message_id && market.announcement_channel_id === channel.id) {
      payload.reply = { messageReference: market.announcement_message_id, failIfNotExists: false };
    }
    await withRetry(() => channel.send(payload), { label: `announce result of #${market.id}` });
  }
}

module.exports = { Notifier };
