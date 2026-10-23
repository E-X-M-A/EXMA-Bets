'use strict';

const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const { withRetry } = require('./retry');
const { getPostableChannel } = require('./channels');
const { messageLink, COLORS } = require('./views');
const { escapeMarkdown, points, signedPoints } = require('../utils/format');

/**
 * Delivers queued notifications from the outbox table: creator reminders when a
 * market closes and per-bettor result DMs. (Results themselves are shown on the
 * market message, which the MarketPublisher keeps up to date.) Each row is delivered at
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
    // Up to 8 batches per run so a large market's result DMs go out promptly;
    // anything left is picked up by the next scheduler tick.
    for (let batch = 0; batch < 8; batch++) {
      const due = this.services.outbox.due(25);
      for (const n of due) {
        try {
          await this.deliver(n);
          this.services.outbox.markSent(n.id);
          delivered++;
        } catch (err) {
          logger.warn(`Notification ${n.id} (${n.kind}) failed: ${err.message ?? err}`);
          this.services.outbox.markFailed(n.id, err.message ?? err, n.attempts);
        }
      }
      if (due.length < 25) break;
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
        // Results are shown on the market message itself; separate result posts were
        // removed. Rows queued by older versions are simply marked as handled.
        return undefined;
      case 'BET_RESULT':
        return this.notifyBettor(market, n.payload.userId);
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
          `(${outcomes}) by pressing the matching **🏁 Resolve** button on the market message.${link}\n\n` +
          `Alternatively, in <#${this.config.bettingChannelId}>: ` +
          `\`/market resolve market_id:${market.id} outcome:<outcome>\`\n\n` +
          'Payouts are made as soon as you confirm the result, and every bettor’s result is shown on the market message.',
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

  /** DMs one bettor what they won, lost or got refunded on a settled market. */
  async notifyBettor(market, userId) {
    const settlement = this.services.settlement.getSettlement(market.id);
    const result = settlement?.payouts.find((p) => p.user_id === userId);
    if (!result) return;
    const embed = bettorResultEmbed(market, settlement, result, {
      bets: this.services.markets.userBets(market.id, userId),
      balance: this.services.users.getUser(userId)?.balance,
      guildId: this.config.guildId,
    });
    try {
      const user = await withRetry(() => this.client.users.fetch(userId), { label: 'fetch bettor' });
      await withRetry(() => user.send({ embeds: [embed], allowedMentions: { parse: [] } }), {
        label: `DM result of #${market.id}`,
      });
    } catch (err) {
      // 50007: DMs closed; 10013: unknown user. The market message still lists their result.
      if (![50007, 10013].includes(err.code)) throw err;
      logger.debug(`Could not DM result of market #${market.id} to ${userId} (${err.code})`);
    }
  }
}

function bettorResultEmbed(market, settlement, result, { bets, balance, guildId }) {
  const net = result.paid - result.staked;
  const byOutcome = market.outcomes
    .map((o) => ({ label: o.label, stake: bets.filter((b) => b.outcome === o.idx).reduce((a, b) => a + b.stake, 0) }))
    .filter((o) => o.stake > 0)
    .map((o) => `${points(o.stake)} on **${escapeMarkdown(o.label)}**`)
    .join(', ');
  const question = `**Market #${market.id}:** ${escapeMarkdown(market.question)}`;
  const link = market.announcement_message_id
    ? `\n[View market](${messageLink(guildId, market.announcement_channel_id, market.announcement_message_id)})`
    : '';
  const footer = balance == null ? '' : `\nYour balance: **${points(balance)}**`;

  let title;
  let color;
  let body;
  if (market.status === 'CANCELLED') {
    title = `↩️ Market #${market.id} was cancelled`;
    color = COLORS.CANCELLED;
    body = `Reason: ${escapeMarkdown(market.cancel_reason ?? '—')}\nYour stake of ${points(result.staked)} was refunded.`;
  } else {
    const winner = escapeMarkdown(market.outcomes[market.winning_outcome].label);
    if (settlement.refunded) {
      title = '↩️ Your stake was refunded';
      color = COLORS.CANCELLED;
      body = `Result: **${winner}**. Nobody bet on it, so all stakes were refunded (${points(result.paid)} to you).`;
    } else if (net > 0) {
      title = `✅ You won ${signedPoints(net)}!`;
      color = COLORS.SUCCESS;
      body = `Result: **${winner}**. You staked ${points(result.staked)} and received **${points(result.paid)}**.`;
    } else if (net === 0) {
      title = '➖ You broke even';
      color = COLORS.INFO;
      body = `Result: **${winner}**. You staked ${points(result.staked)} and got ${points(result.paid)} back.`;
    } else {
      title = `❌ You lost ${points(-net)}`;
      color = COLORS.ERROR;
      body =
        `Result: **${winner}**. You staked ${points(result.staked)}` +
        (result.paid > 0 ? ` and got ${points(result.paid)} back.` : ' and lost it.');
    }
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`${question}\n\n${body}\nYour bets: ${byOutcome || '—'}${footer}${link}`)
    .setFooter({ text: 'Virtual points only — no real-money value.' });
}

module.exports = { Notifier, bettorResultEmbed };
