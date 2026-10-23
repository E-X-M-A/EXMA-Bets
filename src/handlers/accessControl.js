'use strict';

/**
 * Pure access rules for interactions (kept free of discord.js objects so they can be
 * unit-tested). Returns null when allowed, otherwise a short user-facing reason.
 *
 * - Everything must happen in the configured server.
 * - Normal slash commands only work in the betting channel (or its threads).
 * - Admin commands work anywhere in the server but need the Administrator permission.
 * - Buttons/modals work in the betting and announcement channels, so people can bet
 *   straight from the announcement message even if commands are disallowed there.
 */
function checkAccess(config, { guildId, channelId, parentChannelId = null, kind, scope = 'betting', isAdmin = false }) {
  if (!guildId || guildId !== config.guildId) {
    return 'This bot only works in its home server.';
  }
  const inChannel = (id) => channelId === id || parentChannelId === id;

  if (kind === 'command') {
    if (scope === 'admin') return isAdmin ? null : 'You need the Administrator permission to use this command.';
    return inChannel(config.bettingChannelId) ? null : `Please use bot commands in <#${config.bettingChannelId}>.`;
  }
  if (kind === 'component' || kind === 'modal') {
    return inChannel(config.bettingChannelId) || inChannel(config.announcementChannelId)
      ? null
      : `This can only be used in <#${config.bettingChannelId}> or <#${config.announcementChannelId}>.`;
  }
  return null; // autocomplete: guild check only
}

/** Small bounded set used to drop interactions that are delivered twice. */
class SeenSet {
  constructor(limit = 5000) {
    this.limit = limit;
    this.set = new Set();
  }

  /** Returns true if `id` was already seen; records it otherwise. */
  checkAndAdd(id) {
    if (this.set.has(id)) return true;
    this.set.add(id);
    if (this.set.size > this.limit) this.set.delete(this.set.values().next().value);
    return false;
  }
}

module.exports = { checkAccess, SeenSet };
