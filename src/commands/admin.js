'use strict';

const { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const flows = require('../handlers/marketFlows');
const views = require('../discord/views');
const { respond } = require('../discord/interactionUtils');
const { UserError } = require('../utils/errors');
const { MAX_POINTS } = require('../services/userService');
const { LIMITS, STATUS } = require('../services/marketService');
const { points, truncate, escapeMarkdown } = require('../utils/format');
const { discordTimestamp, formatDuration, startOfLocalDay, addDays } = require('../utils/time');

const reasonOption = (o) => o.setName('reason').setDescription('Required; stored in the audit log').setRequired(true).setMaxLength(500);
const marketIdOption = (o) => o.setName('market_id').setDescription('Market ID').setRequired(true).setMinValue(1).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Administrator tools')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((g) =>
    g
      .setName('market')
      .setDescription('Market administration')
      .addSubcommand((s) =>
        s.setName('cancel').setDescription('Cancel a market and refund all stakes').addIntegerOption(marketIdOption).addStringOption(reasonOption),
      )
      .addSubcommand((s) =>
        s
          .setName('resolve')
          .setDescription('Resolve an expired market on behalf of an unavailable creator')
          .addIntegerOption(marketIdOption)
          .addStringOption((o) =>
            o.setName('outcome').setDescription('Winning outcome').setRequired(true).setMaxLength(LIMITS.outcomeMax).setAutocomplete(true),
          )
          .addStringOption(reasonOption),
      )
      .addSubcommand((s) => s.setName('list').setDescription('Expired markets still awaiting resolution')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('points')
      .setDescription('Adjust balances')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Grant points to a member')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Points to add').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
          .addStringOption(reasonOption),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove points from a member (never below zero)')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Points to remove').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))
          .addStringOption(reasonOption),
      ),
  )
  .addSubcommand((s) => s.setName('stats').setDescription('Economy and market statistics'))
  .addSubcommand((s) => s.setName('daily-distribution').setDescription('Status of the automatic daily reward distribution'));

async function execute(ctx, interaction) {
  const { services } = ctx;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const actorId = interaction.user.id;

  if (group === 'market') {
    if (sub === 'cancel') {
      return flows.prepareCancel(ctx, interaction, {
        marketId: interaction.options.getInteger('market_id'),
        reason: interaction.options.getString('reason'),
      });
    }
    if (sub === 'resolve') {
      return flows.prepareResolve(ctx, interaction, {
        marketId: interaction.options.getInteger('market_id'),
        outcome: interaction.options.getString('outcome'),
        admin: true,
        reason: interaction.options.getString('reason').trim(),
      });
    }
    if (sub === 'list') {
      const now = services.clock();
      const markets = services.markets.listAwaitingResolution(25);
      const lines = markets.map(
        (m) =>
          `**#${m.id}** ${escapeMarkdown(truncate(m.question, 70))}\n` +
          `by <@${m.creator_id}> · closed ${discordTimestamp(m.expires_at, 'R')} (${formatDuration(now - m.expires_at)} ago) · ${points(m.totalPool)}`,
      );
      return respond(interaction, {
        embeds: [
          views
            .infoEmbed('🛡️ Markets awaiting resolution', lines.length ? lines.join('\n\n') : 'Nothing is waiting for a result. 🎉', views.COLORS.CLOSED)
            .setFooter({ text: 'Use /admin market resolve or /admin market cancel' }),
        ],
      });
    }
  }

  if (group === 'points') {
    const target = interaction.options.getUser('user', true);
    if (target.bot) throw new UserError('Bots cannot hold points.');
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason', true).trim();
    if (!reason) throw new UserError('A reason is required.');
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_POINTS) throw new UserError('Invalid amount.');
    const member = interaction.guild?.members.cache.get(target.id);
    services.users.ensureUser(target.id, member?.displayName ?? target.globalName ?? target.username);

    const add = sub === 'add';
    const result = services.db.transaction(() => {
      const before = services.users.getUser(target.id).balance;
      if (!add && amount > before) {
        throw new UserError(`Cannot remove ${points(amount)}: <@${target.id}> only has ${points(before)}. Balances never go negative.`);
      }
      const r = services.users.applyTransaction(target.id, add ? amount : -amount, {
        type: add ? 'ADMIN_GRANT' : 'ADMIN_REMOVE',
        key: `admin:${interaction.id}`,
        reason,
      });
      if (r.applied) {
        services.audit.log({
          actorId,
          action: add ? 'ADMIN_POINTS_ADD' : 'ADMIN_POINTS_REMOVE',
          targetType: 'user',
          targetId: target.id,
          reason,
          metadata: { amount, balanceBefore: before, balanceAfter: r.balance },
        });
      }
      return { ...r, before };
    }).immediate();

    return respond(interaction, {
      embeds: [
        views.successEmbed(
          add ? '➕ Points granted' : '➖ Points removed',
          `<@${target.id}>: ${points(result.before)} → **${points(result.balance)}**\nReason: ${escapeMarkdown(reason)}\nLogged in the audit log.`,
        ),
      ],
    });
  }

  if (sub === 'stats') {
    const s = services.stats.adminStats(services.clock());
    const embed = new EmbedBuilder()
      .setColor(views.COLORS.INFO)
      .setTitle('🛡️ Statistics')
      .addFields(
        { name: 'Registered users', value: String(s.users), inline: true },
        { name: 'Open markets', value: String(s.open), inline: true },
        { name: 'Awaiting resolution', value: String(s.awaiting), inline: true },
        { name: 'Resolved markets', value: String(s.resolved), inline: true },
        { name: 'Cancelled markets', value: String(s.cancelled), inline: true },
        { name: 'Total bets', value: String(s.bets), inline: true },
        { name: 'Points in balances', value: points(s.circulating), inline: true },
        { name: 'Points locked in open bets', value: points(s.locked), inline: true },
        { name: 'Total in circulation', value: points(s.circulating + s.locked), inline: true },
      )
      .setFooter({
        text:
          s.ledgerTotal === s.circulating
            ? 'Ledger check: OK (balances match the transaction ledger)'
            : `Ledger check: MISMATCH (ledger ${s.ledgerTotal} vs balances ${s.circulating})`,
      });
    return respond(interaction, { embeds: [embed] });
  }

  if (sub === 'daily-distribution') {
    const { config } = ctx;
    const rows = services.daily.recentDistributions(5);
    const today = services.daily.today();
    const next = startOfLocalDay(addDays(today, 1), config.timezone);
    const icon = { COMPLETED: '✅', IN_PROGRESS: '⏳', FAILED: '⚠️' };
    const lines = rows.map(
      (r) =>
        `${icon[r.status] ?? '•'} **${r.reward_date}** — ${r.status.replace('_', ' ').toLowerCase()}\n` +
        `${r.recipients} recipient(s) · ${points(r.total_points)} distributed` +
        (r.member_count != null ? ` · ${r.member_count} eligible members` : '') +
        ` · ${r.attempts} attempt(s)` +
        (r.completed_at ? ` · finished ${discordTimestamp(r.completed_at, 'R')}` : '') +
        (r.last_error ? `\nLast error: \`${truncate(r.last_error, 200)}\`` : ''),
    );
    const schedulerError = ctx.scheduler?.lastDailyError;
    const embed = views
      .infoEmbed(
        '🛡️ Daily reward distribution',
        (config.dailyReward > 0
          ? `Automatic reward: **${points(config.dailyReward)}** per member at 00:00 ${config.timezone}.\n` +
            `Today (${config.timezone}): **${today}** · next run ${discordTimestamp(next, 'R')}`
          : 'Daily rewards are **disabled** (DAILY_REWARD=0).') +
          (services.daily.pendingDates().length ? `\nPending: ${services.daily.pendingDates().join(', ')}` : '') +
          (schedulerError ? `\n\n⚠️ Last scheduler error ${discordTimestamp(schedulerError.at, 'R')}: \`${truncate(schedulerError.message, 300)}\`` : '') +
          `\n\n${lines.length ? lines.join('\n\n') : 'No distributions yet.'}`,
      )
      .setFooter({ text: 'Monitoring only — payouts run automatically.' });
    return respond(interaction, { embeds: [embed] });
  }

  throw new UserError('Unknown subcommand.');
}

async function autocomplete(ctx, interaction) {
  const { services } = ctx;
  const focused = interaction.options.getFocused(true);
  const sub = interaction.options.getSubcommand();
  if (focused.name === 'market_id') {
    const now = services.clock();
    const rows = services.markets
      .searchMarkets(String(focused.value), { statuses: [STATUS.OPEN, STATUS.AWAITING_RESOLUTION] })
      .filter((m) => sub !== 'resolve' || m.expires_at <= now);
    return interaction.respond(rows.map((m) => ({ name: truncate(`#${m.id} · ${m.question}`, 100), value: m.id })));
  }
  if (focused.name === 'outcome') {
    const market = services.markets.getMarket(interaction.options.get('market_id')?.value);
    return interaction.respond(market ? market.outcomes.map((o) => ({ name: truncate(o.label, 100), value: o.label })) : []);
  }
  return interaction.respond([]);
}

module.exports = { data, execute, autocomplete, scope: 'admin' };
