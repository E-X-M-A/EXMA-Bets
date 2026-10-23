'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ids } = require('./customIds');
const { points, signedPoints, truncate, safeName, progressBar, escapeMarkdown } = require('../utils/format');
const { discordTimestamp } = require('../utils/time');
const { LEADERBOARD_TYPES } = require('../services/statsService');

const COLORS = {
  OPEN: 0x5865f2,
  CLOSED: 0xf0b232,
  RESOLVED: 0x23a55a,
  CANCELLED: 0x80848e,
  ERROR: 0xda373c,
  SUCCESS: 0x23a55a,
  INFO: 0x5865f2,
};
const OUTCOME_ICONS = ['🔵', '🟠', '🟢', '🟣', '🟡', '🔴'];
const MEDALS = ['🥇', '🥈', '🥉'];

const FOOTER =
  'Pari-mutuel: winners share the losing pool in proportion to their stake. ' +
  'Odds are estimates until betting closes. Virtual points only.';

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function statusLine(market, now) {
  switch (market.status) {
    case 'OPEN':
      return now < market.expires_at
        ? `🟢 **Open** · betting closes ${discordTimestamp(market.expires_at, 'R')}`
        : '🟡 **Betting closed** · awaiting resolution';
    case 'AWAITING_RESOLUTION':
      return `🟡 **Betting closed** · waiting for <@${market.creator_id}> to report the result`;
    case 'RESOLVED':
      return `🏁 **Resolved:** ${escapeMarkdown(market.outcomes[market.winning_outcome].label)}`;
    case 'CANCELLED':
      return `⛔ **Cancelled** · all stakes refunded${market.cancel_reason ? `\nReason: ${escapeMarkdown(truncate(market.cancel_reason, 300))}` : ''}`;
    default:
      return market.status;
  }
}

function marketColor(market, now) {
  if (market.status === 'RESOLVED') return COLORS.RESOLVED;
  if (market.status === 'CANCELLED') return COLORS.CANCELLED;
  if (market.status === 'AWAITING_RESOLUTION' || now >= market.expires_at) return COLORS.CLOSED;
  return COLORS.OPEN;
}

function outcomeField(market, outcome) {
  const icon = OUTCOME_ICONS[outcome.idx] ?? '▫️';
  const isWinner = market.status === 'RESOLVED' && market.winning_outcome === outcome.idx;
  const share = market.totalPool > 0 ? outcome.pool / market.totalPool : 1 / market.outcomes.length;
  const lines = [
    `${progressBar(share)} **${outcome.probability.toFixed(1)}%**`,
    `${points(outcome.pool)} · ${outcome.bettors} bettor${outcome.bettors === 1 ? '' : 's'}`,
  ];
  if (market.status === 'OPEN' || market.status === 'AWAITING_RESOLUTION') {
    lines.push(outcome.multiplier ? `Est. payout ≈ **${outcome.multiplier.toFixed(2)}×** stake` : 'Est. payout: no bets yet');
  }
  return {
    name: `${isWinner ? '✅' : icon} ${truncate(outcome.label, 200)}${isWinner ? ' — winner' : ''}`,
    value: lines.join('\n'),
    inline: true,
  };
}

/** The main market embed used in announcements and /market view. */
function marketEmbed(market, { now = Date.now() } = {}) {
  const embed = new EmbedBuilder()
    .setColor(marketColor(market, now))
    .setTitle(truncate(`Market #${market.id} · ${market.question}`, 256))
    .setFooter({ text: FOOTER })
    .setTimestamp(market.created_at);

  const description = [];
  if (market.description) description.push(truncate(market.description, 1500), '');
  description.push(statusLine(market, now));
  embed.setDescription(description.join('\n'));

  embed.addFields(market.outcomes.map((o) => outcomeField(market, o)));
  if (market.outcomes.length % 2 === 1) embed.addFields({ name: '​', value: '​', inline: true });
  embed.addFields(
    { name: 'Total volume', value: points(market.totalPool), inline: true },
    { name: 'Participants', value: String(market.participants), inline: true },
    { name: 'Creator', value: `<@${market.creator_id}>`, inline: true },
    {
      name: now < market.expires_at && market.status === 'OPEN' ? 'Betting closes' : 'Betting closed',
      value: `${discordTimestamp(market.expires_at, 'f')} (${discordTimestamp(market.expires_at, 'R')})`,
      inline: false,
    },
  );
  if (market.status === 'RESOLVED') {
    embed.addFields({
      name: 'Resolved',
      value: `${discordTimestamp(market.resolved_at, 'f')} by <@${market.resolver_id}>${market.resolved_by_admin ? ' (administrator)' : ''}`,
    });
  }
  return embed;
}

/** Bet buttons (disabled once betting closes) plus a "My position" button. */
function marketComponents(market, { now = Date.now() } = {}) {
  const open = market.status === 'OPEN' && now < market.expires_at;
  const row = new ActionRowBuilder();
  for (const o of market.outcomes.slice(0, 4)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ids.bet(market.id, o.idx))
        .setLabel(truncate(`Bet: ${o.label}`, 80))
        .setEmoji(OUTCOME_ICONS[o.idx] ?? '▫️')
        .setStyle(open ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!open),
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(ids.position(market.id)).setLabel('My position').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

function marketMessage(market, opts) {
  return { embeds: [marketEmbed(market, opts)], components: marketComponents(market, opts), allowedMentions: { parse: [] } };
}

function resultEmbed(market, settlement, { guildId } = {}) {
  const link =
    market.announcement_message_id && guildId
      ? `\n[View market](${messageLink(guildId, market.announcement_channel_id, market.announcement_message_id)})`
      : '';
  const pools = market.outcomes.map((o) => `${OUTCOME_ICONS[o.idx] ?? '▫️'} ${escapeMarkdown(o.label)}: ${points(o.pool)}`).join('\n');

  if (market.status === 'CANCELLED') {
    return new EmbedBuilder()
      .setColor(COLORS.CANCELLED)
      .setTitle(truncate(`⛔ Market #${market.id} cancelled`, 256))
      .setDescription(
        `**${escapeMarkdown(market.question)}**\n\nReason: ${escapeMarkdown(market.cancel_reason ?? '—')}\n` +
          `All ${points(settlement?.total_paid ?? 0)} in stakes were refunded.${link}`,
      )
      .addFields({ name: 'Final pools', value: pools });
  }

  const winner = market.outcomes[market.winning_outcome];
  let summary;
  if (!settlement || settlement.total_pool === 0) summary = 'No bets were placed, so no points changed hands.';
  else if (settlement.refunded) summary = `Nobody backed **${escapeMarkdown(winner.label)}**, so every stake was refunded.`;
  else {
    const top = settlement.payouts
      .filter((p) => p.paid > p.staked)
      .slice(0, 5)
      .map((p) => `<@${p.user_id}> ${points(p.paid)} (${signedPoints(p.paid - p.staked)})`);
    summary =
      `${settlement.winner_count} winner${settlement.winner_count === 1 ? '' : 's'} shared ${points(settlement.total_paid)}.` +
      (top.length ? `\n${top.join('\n')}` : '');
  }
  return new EmbedBuilder()
    .setColor(COLORS.RESOLVED)
    .setTitle(truncate(`🏁 Market #${market.id} resolved: ${winner.label}`, 256))
    .setDescription(`**${escapeMarkdown(market.question)}**${link}`)
    .addFields(
      { name: 'Winning outcome', value: `✅ ${escapeMarkdown(winner.label)}`, inline: true },
      { name: 'Total pool', value: points(settlement?.total_pool ?? 0), inline: true },
      { name: 'Final pools', value: pools },
      { name: 'Payouts', value: truncate(summary, 1024) },
    )
    .setFooter({ text: `Resolved by ${market.resolved_by_admin ? 'an administrator' : 'the market creator'}` });
}

function infoEmbed(title, description, color = COLORS.INFO) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

function errorEmbed(message) {
  return new EmbedBuilder().setColor(COLORS.ERROR).setDescription(`❌ ${message}`);
}

function successEmbed(title, description) {
  return new EmbedBuilder().setColor(COLORS.SUCCESS).setTitle(title).setDescription(description);
}

function confirmRow(confirmationId, confirmLabel = 'Confirm', style = ButtonStyle.Success) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ids.confirm(confirmationId)).setLabel(confirmLabel).setStyle(style),
    new ButtonBuilder().setCustomId(ids.abort(confirmationId)).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

/** Prev / indicator / Next. Only used when pages > 1, which keeps the custom IDs distinct. */
function pagerRow(makeId, page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId(Math.max(1, page - 1))).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId('pm:noop').setLabel(`${page} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(makeId(Math.min(pages, page + 1))).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );
}

function leaderboardView(board, names, ownerId) {
  const def = LEADERBOARD_TYPES[board.type];
  const lines = board.rows.map((r) => {
    const badge = MEDALS[r.rank - 1] ?? `\`#${String(r.rank).padStart(2, ' ')}\``;
    const value = def.unit === 'pts' ? (board.type === 'profit' ? signedPoints(r.value) : points(r.value)) : `${r.value} wins`;
    const name = names.get(r.user_id) ?? safeName(r.username ?? `User ${r.user_id.slice(-4)}`);
    const line = `${badge} **${name}** — ${value}`;
    return r.rank <= 3 ? line : line.replace(/\*\*/g, '');
  });
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 Leaderboard — ${def.label}`)
    .setDescription(lines.length ? lines.join('\n') : 'Nobody here yet. Place a bet to get on the board!')
    .setFooter({ text: `Page ${board.page}/${board.pages} · ${board.total} ranked · ties broken by account age` });
  const components = board.pages > 1 ? [pagerRow((p) => ids.leaderboard(board.type, p, ownerId), board.page, board.pages)] : [];
  return { embeds: [embed], components };
}

const STATUS_LABELS = {
  OPEN: 'Open',
  AWAITING_RESOLUTION: 'Awaiting resolution',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

function marketListView(list, status, ownerId, { guildId, now = Date.now() } = {}) {
  const lines = list.markets.map((m) => {
    const link = m.announcement_message_id ? messageLink(guildId, m.announcement_channel_id, m.announcement_message_id) : null;
    const title = escapeMarkdown(truncate(m.question, 80));
    const odds = m.outcomes.map((o) => `${escapeMarkdown(truncate(o.label, 20))} ${o.probability.toFixed(0)}%`).join(' · ');
    let when;
    if (m.status === 'RESOLVED') when = `won by **${escapeMarkdown(truncate(m.outcomes[m.winning_outcome].label, 30))}**`;
    else if (m.status === 'CANCELLED') when = 'cancelled';
    else when = `${now < m.expires_at ? 'closes' : 'closed'} ${discordTimestamp(m.expires_at, 'R')}`;
    return `**#${m.id}** ${link ? `[${title}](${link})` : title}\n${odds} · ${points(m.totalPool)} · ${when}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`📋 Markets — ${STATUS_LABELS[status]}`)
    .setDescription(lines.length ? lines.join('\n\n') : 'No markets in this category.')
    .setFooter({ text: `Page ${list.page}/${list.pages} · ${list.total} market${list.total === 1 ? '' : 's'} · /market view for details` });
  const components = list.pages > 1 ? [pagerRow((p) => ids.marketList(status, p, ownerId), list.page, list.pages)] : [];
  return { embeds: [embed], components };
}

function betStatusText(bet) {
  switch (bet.status) {
    case 'WON':
      return `won ${points(bet.payout)} (${signedPoints(bet.payout - bet.stake)})`;
    case 'LOST':
      return `lost (${signedPoints(-bet.stake)})`;
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'active';
  }
}

module.exports = {
  COLORS,
  OUTCOME_ICONS,
  STATUS_LABELS,
  messageLink,
  marketEmbed,
  marketComponents,
  marketMessage,
  resultEmbed,
  infoEmbed,
  errorEmbed,
  successEmbed,
  confirmRow,
  leaderboardView,
  marketListView,
  betStatusText,
};
