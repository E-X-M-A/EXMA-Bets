'use strict';

const { withRetry } = require('./retry');

/**
 * Returns every non-bot member of the configured server as `{ id, username }`.
 * Requires the privileged "Server Members Intent" (GatewayIntentBits.GuildMembers).
 */
function createMemberSource(client, guildId) {
  return async function fetchEligibleMembers() {
    const guild = await withRetry(() => client.guilds.fetch(guildId), { label: 'fetch guild' });
    const members = await withRetry(() => guild.members.fetch({ time: 120_000 }), { label: 'fetch members', retries: 2 });
    return [...members.values()]
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, username: m.displayName ?? m.user.username }));
  };
}

module.exports = { createMemberSource };
