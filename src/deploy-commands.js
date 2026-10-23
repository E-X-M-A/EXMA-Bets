'use strict';

/**
 * Registers the slash commands for the configured server (guild commands update
 * instantly). Run after changing command definitions: `npm run deploy-commands`.
 */
const { REST, Routes } = require('discord.js');
const { loadConfig, loadDotEnv, ConfigError } = require('./config');
const { commands } = require('./commands');
const logger = require('./utils/logger');

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig(process.env, { require: ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'] });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  logger.addSecret(config.token);

  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.token);
  const result = await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  logger.info(`Registered ${result.length} commands in server ${config.guildId}: ${result.map((c) => `/${c.name}`).join(', ')}`);
}

main().catch((err) => {
  logger.error(`Command registration failed: ${err.status ? `HTTP ${err.status} ` : ''}${err.message}`);
  process.exit(1);
});
