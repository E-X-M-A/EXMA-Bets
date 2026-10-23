'use strict';

const { MessageFlags } = require('discord.js');
const { safeName } = require('../utils/format');
const logger = require('../utils/logger');

/**
 * Sends `payload` as the interaction response, whatever state the interaction is
 * in (fresh, deferred or already replied). Ephemeral by default.
 */
async function respond(interaction, payload, { ephemeral = true } = {}) {
  const body = typeof payload === 'string' ? { content: payload } : { ...payload };
  body.allowedMentions ??= { parse: [] };
  if (interaction.deferred || interaction.replied) {
    if (interaction.deferred && !interaction.replied) return interaction.editReply(body);
    return interaction.followUp({ ...body, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  }
  return interaction.reply({ ...body, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
}

/**
 * Resolves display names for user IDs: current server nickname/display name when
 * the member is still in the server, otherwise the last known name from the
 * database (marked as having left), otherwise a short placeholder.
 */
async function displayNames(ctx, userIds) {
  const names = new Map();
  const unique = [...new Set(userIds)];
  if (!unique.length) return names;
  const guild = ctx.client.guilds.cache.get(ctx.config.guildId);
  if (guild) {
    const missing = unique.filter((id) => !guild.members.cache.has(id));
    if (missing.length) {
      try {
        await guild.members.fetch({ user: missing, time: 10_000 });
      } catch (err) {
        logger.debug(`Member lookup failed: ${err.message}`);
      }
    }
    for (const id of unique) {
      const member = guild.members.cache.get(id);
      if (member) names.set(id, safeName(member.displayName));
    }
  }
  for (const id of unique) {
    if (names.has(id)) continue;
    const known = ctx.services.users.getUser(id)?.username;
    names.set(id, known ? `${safeName(known)} (left)` : `Unknown user …${id.slice(-4)}`);
  }
  return names;
}

/** Display name to store for an interaction user. */
function nameOf(interaction) {
  return interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
}

module.exports = { respond, displayNames, nameOf, EPHEMERAL: MessageFlags.Ephemeral };
