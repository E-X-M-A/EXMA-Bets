'use strict';

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
} = require('discord.js');
const { ids } = require('../discord/customIds');
const views = require('../discord/views');
const { respond, nameOf, EPHEMERAL } = require('../discord/interactionUtils');
const { getPostableChannel } = require('../discord/channels');
const { UserError } = require('../utils/errors');
const { LIMITS } = require('../services/marketService');
const { estimatePayout } = require('../services/marketMath');
const { points, signedPoints, truncate, escapeMarkdown } = require('../utils/format');
const { discordTimestamp } = require('../utils/time');
const logger = require('../utils/logger');

/* ----------------------------------------------------------------------------
 * Market creation
 * ------------------------------------------------------------------------- */

function createModal(prefill = {}) {
  const input = (id, label, { style = TextInputStyle.Short, max, min = 1, required = true, placeholder, value }) => {
    const text = new TextInputBuilder()
      .setCustomId(id)
      .setStyle(style)
      .setRequired(required)
      .setMaxLength(max)
      .setMinLength(required ? min : 0);
    if (placeholder) text.setPlaceholder(placeholder);
    if (value) text.setValue(truncate(value, max));
    return new LabelBuilder().setLabel(label).setTextInputComponent(text);
  };
  return new ModalBuilder()
    .setCustomId(ids.createModal())
    .setTitle('Create a prediction market')
    .addLabelComponents(
      input('question', 'Question', {
        max: LIMITS.questionMax,
        min: LIMITS.questionMin,
        placeholder: 'Will Bitcoin exceed $120,000 by December 31?',
        value: prefill.question,
      }),
      input('outcome_a', 'Outcome A', { max: LIMITS.outcomeMax, placeholder: 'YES', value: prefill.outcomeA }),
      input('outcome_b', 'Outcome B', { max: LIMITS.outcomeMax, placeholder: 'NO', value: prefill.outcomeB }),
      input('duration', 'Betting window (30m, 6h, 2d, 7d…)', { max: 12, placeholder: '7d', value: prefill.duration }),
      input('description', 'Description / resolution criteria (optional)', {
        style: TextInputStyle.Paragraph,
        max: LIMITS.descriptionMax,
        required: false,
        placeholder: 'How will the result be determined? Which source counts?',
        value: prefill.description,
      }),
    );
}

async function createMarket(ctx, interaction, input) {
  const { config, services, publisher } = ctx;
  await interaction.deferReply({ flags: EPHEMERAL });
  // Refuse up front if the market could not be announced.
  const { problem } = await getPostableChannel(ctx.client, config.guildId, config.announcementChannelId);
  if (problem) {
    logger.warn(`Market creation blocked: ${problem}`);
    throw new UserError('Markets cannot be published right now (announcement channel unavailable). Please ask an administrator.');
  }

  const { market, duplicate } = services.markets.createMarket({
    creatorId: interaction.user.id,
    creatorName: nameOf(interaction),
    question: input.question,
    outcomes: [input.outcomeA, input.outcomeB],
    duration: input.duration,
    description: input.description,
    creationKey: `create:${interaction.id}`,
  });
  if (!duplicate) logger.info(`Market #${market.id} created by ${interaction.user.id}`);

  const published = await publisher.sync(market.id);
  const fresh = services.markets.getMarket(market.id);
  const where = fresh.announcement_message_id
    ? `[in the announcement channel](${views.messageLink(config.guildId, fresh.announcement_channel_id, fresh.announcement_message_id)})`
    : `in <#${config.announcementChannelId}>`;
  await interaction.editReply({
    embeds: [
      views.successEmbed(
        `✅ Market #${market.id} created`,
        `**${escapeMarkdown(market.question)}**\n` +
          `Published ${where}. Betting closes ${discordTimestamp(market.expires_at, 'R')}.\n` +
          (published ? '' : '\n⚠️ Publishing is delayed because Discord did not respond; it will be retried automatically.\n') +
          `\nWhen it closes, report the result with \`/market resolve market_id:${market.id}\`. ` +
          'You may bet on your own market like everyone else.',
      ),
    ],
  });
}

/* ----------------------------------------------------------------------------
 * Betting
 * ------------------------------------------------------------------------- */

async function openBetModal(ctx, interaction, marketId, outcomeIdx) {
  const { services } = ctx;
  const market = services.markets.requireMarket(marketId);
  if (!market.outcomes[outcomeIdx]) throw new UserError('This button is outdated.');
  try {
    services.betting.assertOpen(market, services.clock());
  } catch (err) {
    ctx.publisher.sync(market.id); // the message may be stale; refresh it
    throw err;
  }
  const user = services.users.ensureUser(interaction.user.id, nameOf(interaction));
  const outcome = market.outcomes[outcomeIdx];
  const minBet = ctx.config.minBet;
  const stake = new TextInputBuilder()
    .setCustomId('stake')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(16)
    .setPlaceholder(truncate(`Min ${minBet} · balance ${user.balance.toLocaleString('en-US')} · or "max"`, 100));
  const modal = new ModalBuilder()
    .setCustomId(ids.betModal(market.id, outcomeIdx))
    .setTitle(truncate(`Bet on "${outcome.label}"`, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Stake (points)')
        .setDescription(truncate(`Market #${market.id}: ${market.question}`, 100))
        .setTextInputComponent(stake),
    );
  await interaction.showModal(modal);
}

/** Bet modal submitted: validate and ask for confirmation (nothing is charged yet). */
async function prepareBet(ctx, interaction, marketId, outcomeIdx, stakeInput) {
  const { services, config } = ctx;
  const market = services.markets.requireMarket(marketId);
  const now = services.clock();
  services.betting.assertOpen(market, now);
  const outcome = market.outcomes[outcomeIdx];
  if (!outcome) throw new UserError('This button is outdated.');
  const user = services.users.ensureUser(interaction.user.id, nameOf(interaction));
  const stake = services.betting.parseStake(stakeInput, user.balance);
  services.betting.validateStake(stake, user.balance);

  const confirmationId = services.confirmations.create(interaction.user.id, 'bet', { marketId: market.id, outcome: outcomeIdx, stake });
  const pools = market.outcomes.map((o) => o.pool);
  const estimate = estimatePayout(pools, outcomeIdx, stake);
  const embed = views
    .infoEmbed(
      'Confirm your bet',
      `**Market #${market.id}:** ${escapeMarkdown(market.question)}\n` +
        `**Outcome:** ${escapeMarkdown(outcome.label)}\n**Stake:** ${points(stake)}\n` +
        `**Balance after bet:** ${points(user.balance - stake)}\n\n` +
        `If **${escapeMarkdown(outcome.label)}** wins and the pools stayed as they are now, you would receive about ` +
        `**${points(estimate)}** (${signedPoints(estimate - stake)}). This is an estimate: the final payout depends ` +
        `on all bets placed until betting closes ${discordTimestamp(market.expires_at, 'R')}. Bets cannot be withdrawn.`,
    )
    .setFooter({ text: `Minimum bet ${config.minBet} pts · this confirmation expires in 5 minutes` });
  await respond(interaction, { embeds: [embed], components: [views.confirmRow(confirmationId, `Place ${stake.toLocaleString('en-US')} pts bet`)] });
}

/** /market bet: the user typed every parameter, so the bet is placed immediately. */
async function placeBetNow(ctx, interaction, marketId, outcomeInput, amountInput) {
  const { services } = ctx;
  const user = services.users.ensureUser(interaction.user.id, nameOf(interaction));
  const stake = services.betting.parseStake(String(amountInput), user.balance);
  const result = services.betting.placeBet({
    marketId,
    userId: interaction.user.id,
    username: nameOf(interaction),
    outcome: outcomeInput,
    stake,
    idempotencyKey: `cmd:${interaction.id}`,
  });
  await respond(interaction, { embeds: [betPlacedEmbed(ctx, result)] });
  ctx.publisher.sync(result.market.id);
}

function betPlacedEmbed(ctx, { bet, market, balance, duplicate }) {
  const outcome = market.outcomes[bet.outcome];
  const link = market.announcement_message_id
    ? `\n[View market](${views.messageLink(ctx.config.guildId, market.announcement_channel_id, market.announcement_message_id)})`
    : '';
  return views.successEmbed(
    duplicate ? 'ℹ️ Bet already placed' : '✅ Bet placed',
    `${points(bet.stake)} on **${escapeMarkdown(outcome.label)}** in market #${market.id}.\n` +
      `${escapeMarkdown(market.question)}\n\n` +
      `Implied probability now: **${outcome.probability.toFixed(1)}%** · est. payout ≈ ${outcome.multiplier?.toFixed(2) ?? '—'}× stake\n` +
      `Your balance: **${points(balance)}**${link}`,
  );
}

/** "My position" button / part of /market view. */
function positionText(ctx, market, userId) {
  const bets = ctx.services.markets.userBets(market.id, userId);
  if (!bets.length) return 'You have no bets on this market.';
  const byOutcome = market.outcomes.map(() => 0);
  for (const b of bets) byOutcome[b.outcome] += b.stake;
  const lines = bets
    .slice(-10)
    .map((b) => `• ${points(b.stake)} on **${escapeMarkdown(market.outcomes[b.outcome].label)}** — ${views.betStatusText(b)} (${discordTimestamp(b.created_at, 'R')})`);
  if (bets.length > 10) lines.unshift(`…and ${bets.length - 10} earlier bets`);
  if (market.status === 'OPEN' || market.status === 'AWAITING_RESOLUTION') {
    lines.push('', '**If the market closed now:**');
    for (const o of market.outcomes) {
      if (!byOutcome[o.idx]) continue;
      const pay = Number((BigInt(byOutcome[o.idx]) * BigInt(market.totalPool)) / BigInt(o.pool));
      lines.push(`• ${escapeMarkdown(o.label)} wins → ≈ ${points(pay)} back (estimate)`);
    }
  }
  return lines.join('\n');
}

async function showPosition(ctx, interaction, marketId) {
  const market = ctx.services.markets.requireMarket(marketId);
  const user = ctx.services.users.ensureUser(interaction.user.id, nameOf(interaction));
  await respond(interaction, {
    embeds: [
      views.infoEmbed(
        `Your position · Market #${market.id}`,
        `${escapeMarkdown(market.question)}\n\n${positionText(ctx, market, interaction.user.id)}\n\nBalance: **${points(user.balance)}**`,
      ),
    ],
  });
}

/* ----------------------------------------------------------------------------
 * Resolution & cancellation (always confirmed with a button)
 * ------------------------------------------------------------------------- */

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

async function prepareResolve(ctx, interaction, { marketId, outcome, admin = false, reason = null }) {
  const { services } = ctx;
  const market = services.markets.requireMarket(marketId);
  const outcomeIdx = services.settlement.validateResolution(market, {
    outcome,
    actorId: interaction.user.id,
    isAdmin: admin,
  });
  const preview = services.settlement.previewResolution(market, outcomeIdx);
  const label = market.outcomes[outcomeIdx].label;
  let effect;
  if (preview.mode === 'NO_BETS') effect = 'There are no bets, so no points will move.';
  else if (preview.mode === 'REFUND') effect = `Nobody bet on **${escapeMarkdown(label)}**, so all ${points(preview.totalPool)} will be refunded.`;
  else effect = `${preview.winnerCount} winner(s) will share the pool of ${points(preview.totalPool)}.`;

  const confirmationId = services.confirmations.create(interaction.user.id, admin ? 'admin_resolve' : 'resolve', {
    marketId: market.id,
    outcome: outcomeIdx,
    reason,
  });
  await respond(interaction, {
    embeds: [
      views.infoEmbed(
        `${admin ? '🛡️ Administrator resolution' : 'Resolve market'} #${market.id}`,
        `**${escapeMarkdown(market.question)}**\n\nWinning outcome: **${escapeMarkdown(label)}**\n${effect}\n` +
          (admin ? `Reason: ${escapeMarkdown(reason)}\n` : '') +
          '\n⚠️ This is final. Payouts are processed immediately and cannot be undone.',
        views.COLORS.CLOSED,
      ),
    ],
    components: [views.confirmRow(confirmationId, `Resolve as "${truncate(label, 40)}"`, ButtonStyle.Danger)],
  });
}

async function prepareCancel(ctx, interaction, { marketId, reason }) {
  const { services } = ctx;
  const market = services.markets.requireMarket(marketId);
  if (market.status === 'RESOLVED' || market.status === 'CANCELLED') {
    throw new UserError(`Market #${market.id} is already ${market.status.toLowerCase()}.`);
  }
  if (!String(reason ?? '').trim()) throw new UserError('A reason is required.');
  const confirmationId = services.confirmations.create(interaction.user.id, 'admin_cancel', { marketId: market.id, reason });
  await respond(interaction, {
    embeds: [
      views.infoEmbed(
        `🛡️ Cancel market #${market.id}`,
        `**${escapeMarkdown(market.question)}**\n\nAll ${points(market.totalPool)} in stakes will be refunded.\n` +
          `Reason: ${escapeMarkdown(reason)}\n\n⚠️ This is final.`,
        views.COLORS.CLOSED,
      ),
    ],
    components: [views.confirmRow(confirmationId, 'Cancel market & refund', ButtonStyle.Danger)],
  });
}

/* ----------------------------------------------------------------------------
 * Confirmation buttons
 * ------------------------------------------------------------------------- */

async function handleConfirm(ctx, interaction, confirmationId) {
  const { services } = ctx;
  const userId = interaction.user.id;
  let pending;
  try {
    pending = services.confirmations.peek(confirmationId, userId);
  } catch (err) {
    if (err instanceof UserError && err.code === 'ALREADY_CONFIRMED') return respond(interaction, `ℹ️ ${err.message}`);
    throw err;
  }
  if (pending.kind.startsWith('admin_') && !isAdmin(interaction)) {
    throw new UserError('You need the Administrator permission to do this.');
  }

  let embed;
  let marketId;
  try {
    embed = services.confirmations.consume(confirmationId, userId, pending.kind, (p) => {
      marketId = p.marketId;
      switch (pending.kind) {
        case 'bet':
          return betPlacedEmbed(
            ctx,
            services.betting.placeBet({
              marketId: p.marketId,
              userId,
              username: nameOf(interaction),
              outcome: p.outcome,
              stake: p.stake,
              idempotencyKey: `confirm:${confirmationId}`,
            }),
          );
        case 'resolve':
        case 'admin_resolve': {
          const s = services.settlement.resolveMarket({
            marketId: p.marketId,
            outcome: p.outcome,
            actorId: userId,
            isAdmin: pending.kind === 'admin_resolve',
            reason: p.reason,
          });
          return views.successEmbed(
            `🏁 Market #${s.market.id} resolved`,
            `Winning outcome: **${escapeMarkdown(s.market.outcomes[s.market.winning_outcome].label)}**\n` +
              (s.mode === 'NO_BETS'
                ? 'No bets were placed.'
                : s.mode === 'REFUND'
                  ? `Nobody backed the winning outcome; ${points(s.totalPaid)} refunded.`
                  : `${s.winnerCount} winner(s) received ${points(s.totalPaid)}.`) +
              '\nThe result has been announced.',
          );
        }
        case 'admin_cancel': {
          const s = services.settlement.cancelMarket({ marketId: p.marketId, actorId: userId, reason: p.reason });
          return views.successEmbed(`⛔ Market #${s.market.id} cancelled`, `${points(s.totalPaid)} refunded. The cancellation was logged.`);
        }
        default:
          throw new UserError('Unknown action.');
      }
    });
  } catch (err) {
    if (err instanceof UserError && err.code !== 'ALREADY_CONFIRMED') {
      return interaction.update({ embeds: [views.errorEmbed(err.message)], components: [] });
    }
    throw err;
  }

  await interaction.update({ embeds: [embed], components: [] });
  if (marketId) {
    ctx.publisher.sync(marketId);
    ctx.notifier.dispatch();
  }
}

async function handleAbort(ctx, interaction, confirmationId) {
  try {
    ctx.services.confirmations.consume(confirmationId, interaction.user.id, null, () => null);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    if (err.code === 'NOT_YOURS') throw err;
  }
  await interaction.update({ embeds: [views.infoEmbed('Cancelled', 'Nothing was changed.', views.COLORS.CANCELLED)], components: [] });
}

/** Link button to a market's announcement message, if it exists. */
function marketLinkRow(ctx, market) {
  if (!market.announcement_message_id) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Open announcement')
      .setURL(views.messageLink(ctx.config.guildId, market.announcement_channel_id, market.announcement_message_id)),
  );
}

module.exports = {
  createModal,
  createMarket,
  openBetModal,
  prepareBet,
  placeBetNow,
  positionText,
  showPosition,
  prepareResolve,
  prepareCancel,
  handleConfirm,
  handleAbort,
  marketLinkRow,
  isAdmin,
};
