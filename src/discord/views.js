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
const OUTCOME_ICONS = ['🔵', '🟠', '🟢', '🟣', '🟡', '🔴', '🟤', '⚪', '⚫', '🔷'];
const outcomeIcon = (idx) => OUTCOME_ICONS[idx] ?? '▫️';
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
        : `🟡 **Betting closed** · waiting for <@${market.creator_id}> to pick the result with the buttons below`;
    case 'AWAITING_RESOLUTION':
      return `🟡 **Betting closed** · waiting for <@${market.creator_id}> to pick the result with the buttons below`;
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
  const icon = outcomeIcon(outcome.idx);
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

function isAwaitingResolution(market, now) {
  return market.status === 'AWAITING_RESOLUTION' || (market.status === 'OPEN' && now >= market.expires_at);
}

/** One line per bettor describing what they won or lost, best result first. */
function bettorResultLines(settlement) {
  const rows = [...settlement.payouts].sort(
    (a, b) => b.paid - b.staked - (a.paid - a.staked) || b.staked - a.staked || a.user_id.localeCompare(b.user_id),
  );
  return rows.map((p) => {
    const net = p.paid - p.staked;
    if (settlement.refunded) return `↩️ <@${p.user_id}> refunded ${points(p.paid)}`;
    if (net > 0) return `✅ <@${p.user_id}> won **${signedPoints(net)}** (staked ${points(p.staked)}, paid ${points(p.paid)})`;
    if (net === 0) return `➖ <@${p.user_id}> broke even (${points(p.paid)} back)`;
    const back = p.paid > 0 ? ` (staked ${points(p.staked)}, got ${points(p.paid)} back)` : '';
    return `❌ <@${p.user_id}> lost **${points(-net)}**${back}`;
  });
}

const RESULTS_PAGE_SIZE = 10;

function resultsTitle(settlement) {
  const n = settlement.payouts.length;
  if (settlement.refunded) return `Results · all ${n} bettor${n === 1 ? '' : 's'} refunded`;
  const winners = settlement.payouts.filter((p) => p.paid > p.staked).length;
  const losers = settlement.payouts.filter((p) => p.paid < p.staked).length;
  return `Results · ${winners} won, ${losers} lost`;
}

/** One page of result lines: `{ lines, page, pages, total }` (page is clamped). */
function resultPage(settlement, page = 1, pageSize = RESULTS_PAGE_SIZE) {
  const all = bettorResultLines(settlement);
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { lines: all.slice((current - 1) * pageSize, current * pageSize), page: current, pages, total: all.length };
}

/** Splits lines into embed field values of at most 1024 characters. */
function chunkLines(lines) {
  const chunks = [[]];
  for (const line of lines) {
    if ([...chunks.at(-1), line].join('\n').length > 1024) chunks.push([]);
    chunks.at(-1).push(line);
  }
  return chunks.map((c) => c.join('\n'));
}

/**
 * Results fields for one page of a resolved market's bettors. The market message
 * shows page 1; the "All results" button opens a private, pageable copy.
 */
function resultFields(settlement, { page = 1 } = {}) {
  const r = resultPage(settlement, page);
  if (!r.total) return [{ name: 'Results', value: 'No bets were placed, so no points changed hands.' }];
  const title = `${resultsTitle(settlement)}${r.pages > 1 ? ` (page ${r.page}/${r.pages})` : ''}`;
  const values = chunkLines(r.lines);
  if (r.pages > 1 && page === 1) values[values.length - 1] += `\n*Showing ${r.lines.length} of ${r.total}. Press **📄 All results** to see everyone.*`;
  return values.map((value, i) => ({ name: i === 0 ? title : 'Results (continued)', value }));
}

/**
 * Private, pageable results list ("All results" button). The viewer's own result
 * is pinned at the top so they never have to search for it.
 */
function resultsView(market, settlement, page, viewerId) {
  const r = resultPage(settlement, page);
  const own = bettorResultLines({ ...settlement, payouts: settlement.payouts.filter((p) => p.user_id === viewerId) })[0];
  const winner = market.winning_outcome != null ? market.outcomes[market.winning_outcome].label : null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.RESOLVED)
    .setTitle(truncate(`${resultsTitle(settlement)} · Market #${market.id}`, 256))
    .setDescription(
      `**${escapeMarkdown(truncate(market.question, 300))}**` +
        (winner ? `\nWinning outcome: **${escapeMarkdown(winner)}**` : '') +
        (own ? `\n\n**Your result:** ${own}` : '') +
        `\n\n${r.lines.join('\n') || 'No bets were placed.'}`,
    )
    .setFooter({ text: `Page ${r.page}/${r.pages} · ${r.total} bettor${r.total === 1 ? '' : 's'} · best result first` });
  const components = r.pages > 1 ? [pagerRow((p) => ids.resultsPage(market.id, p), r.page, r.pages)] : [];
  return { embeds: [embed], components };
}

/**
 * The main market embed used in announcements and /market view. Pass the market's
 * `settlement` (from SettlementService#getSettlement) to list each bettor's result.
 */
function marketEmbed(market, { now = Date.now(), settlement = null } = {}) {
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
  // Pad the outcome grid to full rows of three so the summary fields start on a new row.
  for (let i = market.outcomes.length; i % 3 !== 0; i++) embed.addFields({ name: '\u200b', value: '\u200b', inline: true });
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
    if (settlement) embed.addFields(resultFields(settlement));
  }
  return embed;
}

/** Groups buttons into action rows of at most 5. */
function buttonRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

/**
 * Market buttons, laid out within Discord's 5 rows x 5 buttons:
 * - one "Bet" button per outcome (disabled once betting closes)
 * - utility buttons: "My position", "All results" (resolved markets with more than
 *   one page of results) and an optional link button (`linkUrl`)
 * - after betting closes and until the market is settled, one "Resolve" button per
 *   outcome (usable by the creator or an administrator)
 * When the bet and utility buttons fit in one row (2-3 outcomes) they share it.
 * With the maximum of 10 outcomes: 2 bet rows + 1 utility row + 2 resolve rows.
 */
function marketComponents(market, { now = Date.now(), settlement = null, linkUrl = null } = {}) {
  const open = market.status === 'OPEN' && now < market.expires_at;
  const betButtons = market.outcomes.map((o) =>
    new ButtonBuilder()
      .setCustomId(ids.bet(market.id, o.idx))
      .setLabel(truncate(`Bet: ${o.label}`, 80))
      .setEmoji(outcomeIcon(o.idx))
      .setStyle(open ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!open),
  );
  const utility = [
    new ButtonBuilder().setCustomId(ids.position(market.id)).setLabel('My position').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  ];
  if (market.status === 'RESOLVED' && settlement && settlement.payouts.length > RESULTS_PAGE_SIZE) {
    utility.push(
      new ButtonBuilder()
        .setCustomId(ids.results(market.id))
        .setLabel(`All results (${settlement.payouts.length})`)
        .setEmoji('📄')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (linkUrl) utility.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open announcement').setURL(linkUrl));

  const rows =
    betButtons.length + utility.length <= 5
      ? buttonRows([...betButtons, ...utility])
      : [...buttonRows(betButtons), ...buttonRows(utility)];
  if (isAwaitingResolution(market, now)) {
    rows.push(
      ...buttonRows(
        market.outcomes.map((o) =>
          new ButtonBuilder()
            .setCustomId(ids.resolve(market.id, o.idx))
            .setLabel(truncate(`Resolve: ${o.label}`, 80))
            .setEmoji('🏁')
            .setStyle(ButtonStyle.Success),
        ),
      ),
    );
  }
  return rows;
}

function marketMessage(market, opts) {
  return { embeds: [marketEmbed(market, opts)], components: marketComponents(market, opts), allowedMentions: { parse: [] } };
}

function resultEmbed(market, settlement, { guildId } = {}) {
  const link =
    market.announcement_message_id && guildId
      ? `\n[View market](${messageLink(guildId, market.announcement_channel_id, market.announcement_message_id)})`
      : '';
  const pools = market.outcomes.map((o) => `${outcomeIcon(o.idx)} ${escapeMarkdown(o.label)}: ${points(o.pool)}`).join('\n');

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
  resultFields,
  resultsView,
  RESULTS_PAGE_SIZE,
  resultEmbed,
  infoEmbed,
  errorEmbed,
  successEmbed,
  confirmRow,
  leaderboardView,
  marketListView,
  betStatusText,
};
