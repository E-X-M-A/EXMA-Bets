'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const flows = require('../handlers/marketFlows');
const views = require('../discord/views');
const { respond, displayNames, nameOf } = require('../discord/interactionUtils');
const { LIMITS, STATUS } = require('../services/marketService');
const { UserError } = require('../utils/errors');
const { points, signedPoints, truncate, escapeMarkdown } = require('../utils/format');
const { discordTimestamp } = require('../utils/time');

const STATUS_CHOICES = [
  { name: 'Open', value: STATUS.OPEN },
  { name: 'Awaiting resolution', value: STATUS.AWAITING_RESOLUTION },
  { name: 'Resolved', value: STATUS.RESOLVED },
  { name: 'Cancelled', value: STATUS.CANCELLED },
];

const OUTCOME_OPTION_LETTERS = 'abcdefghij'.slice(0, LIMITS.maxOutcomes).split('');

const marketIdOption = (o) =>
  o.setName('market_id').setDescription('Market ID (e.g. 12)').setRequired(true).setMinValue(1).setAutocomplete(true);
const outcomeOption = (o, description) =>
  o.setName('outcome').setDescription(description).setRequired(true).setMaxLength(LIMITS.outcomeMax).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('market')
  .setDescription('Prediction markets')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => {
    s
      .setName('create')
      .setDescription('Create a market (leave options empty to use a form)')
      .addStringOption((o) => o.setName('question').setDescription('The prediction question').setMaxLength(LIMITS.questionMax))
      .addStringOption((o) => o.setName('outcome_a').setDescription('First outcome, e.g. YES').setMaxLength(LIMITS.outcomeMax))
      .addStringOption((o) => o.setName('outcome_b').setDescription('Second outcome, e.g. NO').setMaxLength(LIMITS.outcomeMax))
      .addStringOption((o) => o.setName('duration').setDescription('Betting window: 30m, 6h, 2d, 7d…').setMaxLength(12))
      .addStringOption((o) =>
        o.setName('description').setDescription('Context or resolution criteria').setMaxLength(LIMITS.descriptionMax),
      );
    // outcome_c ... outcome_j: optional extra outcomes (up to LIMITS.maxOutcomes in total).
    for (const letter of OUTCOME_OPTION_LETTERS.slice(2)) {
      s.addStringOption((o) =>
        o.setName(`outcome_${letter}`).setDescription('Optional extra outcome').setMaxLength(LIMITS.outcomeMax),
      );
    }
    return s;
  })
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription('List markets')
      .addStringOption((o) => o.setName('status').setDescription('Which markets (default: open)').addChoices(...STATUS_CHOICES))
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  )
  .addSubcommand((s) =>
    s.setName('view').setDescription('Show a market and your bets on it').addIntegerOption(marketIdOption),
  )
  .addSubcommand((s) =>
    s
      .setName('bet')
      .setDescription('Bet on a market')
      .addIntegerOption(marketIdOption)
      .addStringOption((o) => outcomeOption(o, 'Outcome to bet on'))
      .addIntegerOption((o) => o.setName('amount').setDescription('Stake in points').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((s) =>
    s
      .setName('resolve')
      .setDescription('Report the result of your expired market')
      .addIntegerOption(marketIdOption)
      .addStringOption((o) => outcomeOption(o, 'The outcome that actually happened')),
  )
  .addSubcommand((s) =>
    s
      .setName('history')
      .setDescription('Recent bets and payouts')
      .addUserOption((o) => o.setName('user').setDescription('Whose history (default: you)')),
  );

async function execute(ctx, interaction) {
  const sub = interaction.options.getSubcommand();
  const { services } = ctx;
  services.users.ensureUser(interaction.user.id, nameOf(interaction));

  switch (sub) {
    case 'create': {
      const input = {
        question: interaction.options.getString('question'),
        outcomes: OUTCOME_OPTION_LETTERS.map((l) => interaction.options.getString(`outcome_${l}`)).filter((o) => o?.trim()),
        duration: interaction.options.getString('duration'),
        description: interaction.options.getString('description'),
      };
      if (input.question && input.outcomes.length >= LIMITS.minOutcomes && input.duration) {
        return flows.createMarket(ctx, interaction, input);
      }
      return interaction.showModal(flows.createModal(input));
    }

    case 'list': {
      const status = interaction.options.getString('status') ?? STATUS.OPEN;
      const page = interaction.options.getInteger('page') ?? 1;
      const list = services.markets.listMarkets(status, page, 5);
      return respond(
        interaction,
        views.marketListView(list, status, interaction.user.id, { guildId: ctx.config.guildId, now: services.clock() }),
        { ephemeral: false },
      );
    }

    case 'view': {
      const market = services.markets.requireMarket(interaction.options.getInteger('market_id'));
      const now = services.clock();
      const settlement = market.status === 'RESOLVED' ? services.settlement.getSettlement(market.id) : null;
      const embed = views.marketEmbed(market, { now, settlement });
      embed.addFields({ name: 'Your bets', value: truncate(flows.positionText(ctx, market, interaction.user.id), 1024) });
      const linkUrl = market.announcement_message_id
        ? views.messageLink(ctx.config.guildId, market.announcement_channel_id, market.announcement_message_id)
        : null;
      const components = views.marketComponents(market, { now, settlement, linkUrl });
      return respond(interaction, { embeds: [embed], components });
    }

    case 'bet':
      return flows.placeBetNow(
        ctx,
        interaction,
        interaction.options.getInteger('market_id'),
        interaction.options.getString('outcome'),
        interaction.options.getInteger('amount'),
      );

    case 'resolve':
      return flows.prepareResolve(ctx, interaction, {
        marketId: interaction.options.getInteger('market_id'),
        outcome: interaction.options.getString('outcome'),
      });

    case 'history': {
      const target = interaction.options.getUser('user') ?? interaction.user;
      if (target.bot) throw new UserError('Bots do not bet.');
      const bets = services.stats.history(target.id, 10);
      const [name] = (await displayNames(ctx, [target.id])).values();
      const lines = bets.map((b) => {
        const result =
          b.status === 'WON'
            ? `✅ won ${points(b.payout)} (${signedPoints(b.payout - b.stake)})`
            : b.status === 'LOST'
              ? `❌ lost ${points(b.stake)}`
              : b.status === 'REFUNDED'
                ? '↩️ refunded'
                : '⏳ active';
        return (
          `**#${b.market_id}** ${escapeMarkdown(truncate(b.question, 60))}\n` +
          `${points(b.stake)} on **${escapeMarkdown(truncate(b.outcome_label, 30))}** · ${result} · ${discordTimestamp(b.created_at, 'R')}`
        );
      });
      return respond(interaction, {
        embeds: [views.infoEmbed(`📜 Bet history — ${name}`, lines.length ? lines.join('\n\n') : 'No bets yet.').setFooter({ text: 'Most recent 10 bets' })],
      });
    }

    default:
      throw new UserError('Unknown subcommand.');
  }
}

async function autocomplete(ctx, interaction) {
  const { services } = ctx;
  const focused = interaction.options.getFocused(true);
  const sub = interaction.options.getSubcommand();

  if (focused.name === 'market_id') {
    const statusesBySub = {
      bet: [STATUS.OPEN],
      resolve: [STATUS.OPEN, STATUS.AWAITING_RESOLUTION],
      view: Object.values(STATUS),
    };
    const now = services.clock();
    const rows = services.markets
      .searchMarkets(String(focused.value), {
        statuses: statusesBySub[sub] ?? Object.values(STATUS),
        creatorId: sub === 'resolve' ? interaction.user.id : null,
      })
      .filter((m) => (sub === 'bet' ? m.expires_at > now : sub === 'resolve' ? m.expires_at <= now : true));
    return interaction.respond(rows.map((m) => ({ name: truncate(`#${m.id} · ${m.question}`, 100), value: m.id })));
  }

  if (focused.name === 'outcome') {
    const marketId = interaction.options.get('market_id')?.value;
    const market = marketId ? services.markets.getMarket(marketId) : null;
    if (!market) return interaction.respond([]);
    const q = String(focused.value).toLowerCase();
    return interaction.respond(
      market.outcomes
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({ name: truncate(`${o.label} (${o.probability.toFixed(1)}%)`, 100), value: o.label })),
    );
  }
  return interaction.respond([]);
}

module.exports = { data, execute, autocomplete, scope: 'betting' };
