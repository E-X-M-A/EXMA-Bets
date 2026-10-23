'use strict';

const { SlashCommandBuilder, InteractionContextType, EmbedBuilder } = require('discord.js');
const views = require('../discord/views');
const { respond, displayNames, nameOf } = require('../discord/interactionUtils');
const { UserError } = require('../utils/errors');
const { points, signedPoints } = require('../utils/format');
const { discordTimestamp, startOfLocalDay, addDays } = require('../utils/time');
const { LEADERBOARD_TYPES } = require('../services/statsService');

/** /balance, /leaderboard, /profile and /help. */

function targetUser(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  if (target.bot) throw new UserError('Bots do not have a balance.');
  return target;
}

function nextRewardLine(ctx) {
  const { config, services } = ctx;
  if (!services.daily.enabled) return '';
  const next = startOfLocalDay(addDays(services.daily.today(), 1), config.timezone);
  return `\nNext automatic daily reward (+${points(config.dailyReward)}) ${discordTimestamp(next, 'R')}.`;
}

const balance = {
  scope: 'betting',
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show your (or another member’s) point balance')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Member to look up')),
  async execute(ctx, interaction) {
    const { services } = ctx;
    services.users.ensureUser(interaction.user.id, nameOf(interaction));
    const target = targetUser(interaction);
    const account = services.users.getUser(target.id);
    const self = target.id === interaction.user.id;
    const [name] = (await displayNames(ctx, [target.id])).values();
    if (!account) {
      return respond(interaction, `**${name}** has no account yet. Accounts are created on first interaction or at the next daily reward.`);
    }
    const profile = services.stats.profile(target.id);
    return respond(interaction, {
      embeds: [
        views.infoEmbed(
          `💰 ${self ? 'Your balance' : `${name}'s balance`}`,
          `**${points(account.balance)}** · rank #${profile.rank}` +
            (profile.at_stake ? `\n${points(profile.at_stake)} currently at stake in open bets` : '') +
            (self ? nextRewardLine(ctx) : ''),
        ).setFooter({ text: 'Virtual points only — no real-money value.' }),
      ],
    });
  },
};

const leaderboard = {
  scope: 'betting',
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top players')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Ranking (default: current balance)')
        .addChoices(...Object.entries(LEADERBOARD_TYPES).map(([value, def]) => ({ name: def.label, value }))),
    )
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async execute(ctx, interaction) {
    ctx.services.users.ensureUser(interaction.user.id, nameOf(interaction));
    const type = interaction.options.getString('type') ?? 'balance';
    const page = interaction.options.getInteger('page') ?? 1;
    return respond(interaction, await renderLeaderboard(ctx, type, page, interaction.user.id), { ephemeral: false });
  },
};

async function renderLeaderboard(ctx, type, page, ownerId) {
  const board = ctx.services.stats.leaderboard(type, page, ctx.config.leaderboardPageSize);
  const names = await displayNames(ctx, board.rows.map((r) => r.user_id));
  return views.leaderboardView(board, names, ownerId);
}

const profile = {
  scope: 'betting',
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Betting statistics for you or another member')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Member to look up')),
  async execute(ctx, interaction) {
    const { services } = ctx;
    services.users.ensureUser(interaction.user.id, nameOf(interaction));
    const target = targetUser(interaction);
    const account = services.users.getUser(target.id);
    const [name] = (await displayNames(ctx, [target.id])).values();
    if (!account) return respond(interaction, `**${name}** has no account yet.`);
    const p = services.stats.profile(target.id);
    const settled = p.wins + p.losses;
    const embed = new EmbedBuilder()
      .setColor(views.COLORS.INFO)
      .setTitle(`📊 ${name}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Balance', value: `${points(account.balance)} (rank #${p.rank})`, inline: true },
        { name: 'Net profit/loss', value: signedPoints(p.net), inline: true },
        { name: 'Total wagered', value: points(p.wagered), inline: true },
        { name: 'Bets placed', value: `${p.bets} (${p.active} active)`, inline: true },
        { name: 'Winning bets', value: settled ? `${p.wins} of ${settled} (${Math.round((p.wins / settled) * 100)}%)` : '0', inline: true },
        { name: 'Markets created', value: `${p.created} (${p.resolved} resolved)`, inline: true },
      )
      .setFooter({ text: 'Net profit/loss counts settled bets only (refunds excluded).' })
      .setTimestamp(account.created_at);
    return respond(interaction, { embeds: [embed] });
  },
};

const help = {
  scope: 'betting',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How the prediction market works')
    .setContexts(InteractionContextType.Guild),
  async execute(ctx, interaction) {
    const { config } = ctx;
    const embed = new EmbedBuilder()
      .setColor(views.COLORS.INFO)
      .setTitle('📈 Prediction markets — how it works')
      .setDescription(
        `Bet **virtual points** (no real-money value) on the outcome of questions created by members. ` +
          `Everyone starts with **${points(config.initialBalance)}**` +
          (config.dailyReward > 0
            ? ` and automatically receives **${points(config.dailyReward)}** every day at 00:00 (${config.timezone}) — no command needed.`
            : '.'),
      )
      .addFields(
        {
          name: 'Betting',
          value:
            `New markets appear in <#${config.announcementChannelId}>. Click an outcome button, enter a stake ` +
            `(min ${config.minBet}) and confirm. You can bet several times, on either side; placed bets are final.`,
        },
        {
          name: 'Payouts (pari-mutuel)',
          value:
            'All stakes go into one pool. When the market resolves, winners get their stake back **plus** a share of the ' +
            'losing side’s pool proportional to their stake. Odds and probabilities shown are estimates from the current ' +
            'stakes and change until betting closes. If nobody backed the winning outcome, everyone is refunded.',
        },
        {
          name: 'Lifecycle',
          value:
            'Open → betting closes at the deadline → the creator reports the result with `/market resolve` → payouts. ' +
            'Administrators can cancel a market (full refund) or resolve it if the creator is unavailable.',
        },
        {
          name: 'Commands',
          value: [
            '`/market create` – create a market',
            '`/market list` · `/market view` – browse markets',
            '`/market bet` – bet without buttons',
            '`/market resolve` – report your market’s result',
            '`/market history` – recent bets & payouts',
            '`/balance` · `/profile` · `/leaderboard`',
          ].join('\n'),
        },
      )
      .setFooter({ text: `Use bot commands in #${interaction.guild?.channels.cache.get(config.bettingChannelId)?.name ?? 'the betting channel'}.` });
    return respond(interaction, { embeds: [embed] });
  },
};

module.exports = { balance, leaderboard, profile, help, renderLeaderboard };
