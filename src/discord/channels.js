'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { withRetry } = require('./retry');

const SEND_PERMISSIONS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
];

/**
 * Fetches a configured channel and checks the bot can post embeds there.
 * Returns `{ channel }` on success or `{ problem }` with a human-readable reason.
 */
async function getPostableChannel(client, guildId, channelId) {
  let channel;
  try {
    channel = await withRetry(() => client.channels.fetch(channelId), { label: `fetch channel ${channelId}` });
  } catch (err) {
    return { problem: `channel ${channelId} is missing or inaccessible (${err.code ?? err.message})` };
  }
  if (!channel) return { problem: `channel ${channelId} does not exist` };
  if (channel.guildId !== guildId) return { problem: `channel ${channelId} is not in the configured server` };
  if (!channel.isTextBased() || typeof channel.send !== 'function') {
    return { problem: `channel ${channelId} is not a text channel` };
  }
  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = SEND_PERMISSIONS.filter(([, flag]) => !perms?.has(flag)).map(([name]) => name);
  if (missing.length) return { channel, problem: `missing permissions in <#${channelId}>: ${missing.join(', ')}` };
  return { channel };
}

module.exports = { getPostableChannel };
