'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { commands } = require('../commands');
const { renderLeaderboard } = require('../commands/user');
const flows = require('./marketFlows');
const views = require('../discord/views');
const { parseCustomId } = require('../discord/customIds');
const { respond } = require('../discord/interactionUtils');
const { checkAccess, SeenSet } = require('./accessControl');
const { UserError } = require('../utils/errors');
const logger = require('../utils/logger');

function interactionKind(interaction) {
  if (interaction.isChatInputCommand()) return 'command';
  if (interaction.isAutocomplete()) return 'autocomplete';
  if (interaction.isModalSubmit()) return 'modal';
  if (interaction.isMessageComponent()) return 'component';
  return null;
}

/** Builds the single `interactionCreate` listener that validates and routes everything. */
function createInteractionHandler(ctx) {
  const seen = new SeenSet();

  return async function onInteraction(interaction) {
    const kind = interactionKind(interaction);
    if (!kind) return;
    if (seen.checkAndAdd(interaction.id)) {
      logger.warn(`Dropping duplicate interaction ${interaction.id}`);
      return;
    }

    const command = kind === 'command' || kind === 'autocomplete' ? commands.get(interaction.commandName) : null;
    try {
      const denied = checkAccess(ctx.config, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        parentChannelId: interaction.channel?.isThread?.() ? interaction.channel.parentId : null,
        kind,
        scope: command?.scope,
        isAdmin: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
      });
      if (denied) {
        if (kind === 'autocomplete') return await interaction.respond([]);
        return await respond(interaction, { embeds: [views.errorEmbed(denied)] });
      }

      switch (kind) {
        case 'command':
          if (!command) throw new UserError('Unknown command. The command list may be outdated.');
          return await command.execute(ctx, interaction);
        case 'autocomplete':
          return await (command?.autocomplete ? command.autocomplete(ctx, interaction) : interaction.respond([]));
        case 'modal':
          return await handleModal(ctx, interaction);
        case 'component':
          return await handleComponent(ctx, interaction);
        default:
          return undefined;
      }
    } catch (err) {
      await reportError(interaction, err, kind);
    }
  };
}

async function handleModal(ctx, interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) throw new UserError('This form is outdated. Please try again.');
  const field = (id) => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return '';
    }
  };
  switch (parsed.type) {
    case 'createModal':
      return flows.createMarket(ctx, interaction, {
        question: field('question'),
        outcomeA: field('outcome_a'),
        outcomeB: field('outcome_b'),
        duration: field('duration'),
        description: field('description'),
      });
    case 'betModal':
      return flows.prepareBet(ctx, interaction, Number(parsed.args[0]), Number(parsed.args[1]), field('stake'));
    default:
      throw new UserError('This form is outdated. Please try again.');
  }
}

async function handleComponent(ctx, interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || !interaction.isButton()) throw new UserError('This button is outdated.');
  const [a, b, c] = parsed.args;
  switch (parsed.type) {
    case 'bet':
      return flows.openBetModal(ctx, interaction, Number(a), Number(b));
    case 'position':
      return flows.showPosition(ctx, interaction, Number(a));
    case 'confirm':
      return flows.handleConfirm(ctx, interaction, a);
    case 'abort':
      return flows.handleAbort(ctx, interaction, a);
    case 'leaderboard':
    case 'marketList': {
      if (c !== interaction.user.id) {
        throw new UserError(`Run \`/${parsed.type === 'leaderboard' ? 'leaderboard' : 'market list'}\` to browse your own copy.`);
      }
      const view =
        parsed.type === 'leaderboard'
          ? await renderLeaderboard(ctx, a, Number(b), c)
          : views.marketListView(ctx.services.markets.listMarkets(a, Number(b), 5), a, c, {
              guildId: ctx.config.guildId,
              now: ctx.services.clock(),
            });
      return interaction.update({ ...view, allowedMentions: { parse: [] } });
    }
    default:
      throw new UserError('This button is outdated.');
  }
}

async function reportError(interaction, err, kind) {
  const expected = err instanceof UserError;
  if (!expected) logger.error(`Error handling ${kind} ${interaction.commandName ?? interaction.customId ?? ''}:`, err);
  if (kind === 'autocomplete') {
    if (!interaction.responded) await interaction.respond([]).catch(() => {});
    return;
  }
  const message = expected ? err.message : 'Something went wrong on our side. Please try again in a moment.';
  try {
    await respond(interaction, { embeds: [views.errorEmbed(message)], components: [] });
  } catch (replyErr) {
    // 10062 Unknown interaction: the 3-second window passed; nothing more we can do.
    logger.debug(`Could not report error to user: ${replyErr.message}`);
  }
}

module.exports = { createInteractionHandler };
