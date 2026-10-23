'use strict';

const { Client, GatewayIntentBits, Events, Options } = require('discord.js');
const { loadConfig, loadDotEnv, ConfigError } = require('./config');
const logger = require('./utils/logger');
const { openDatabase } = require('./database');
const { createServices } = require('./services');
const { MarketPublisher } = require('./discord/marketPublisher');
const { Notifier } = require('./discord/notifier');
const { getPostableChannel } = require('./discord/channels');
const { createMemberSource } = require('./discord/members');
const { createInteractionHandler } = require('./handlers/interactionHandler');
const { Scheduler } = require('./scheduler');

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n\nCopy .env.example to .env and fill in the values.\n`);
      process.exit(1);
    }
    throw err;
  }
  logger.setLevel(config.logLevel);
  logger.addSecret(config.token);

  const db = openDatabase(config.databasePath);
  logger.info(`Database ready at ${config.databasePath}`);
  const services = createServices(db, config);

  const client = new Client({
    // GuildMembers is privileged: enable "Server Members Intent" in the Developer Portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [] },
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
  });

  const publisher = new MarketPublisher(client, services, config);
  const notifier = new Notifier(client, services, config);
  const scheduler = new Scheduler({
    services,
    publisher,
    notifier,
    memberSource: createMemberSource(client, config.guildId),
  });
  const ctx = { client, config, services, publisher, notifier, scheduler };

  client.on(Events.InteractionCreate, createInteractionHandler(ctx));
  client.on(Events.Error, (err) => logger.error('Discord client error:', err));
  client.on(Events.Warn, (msg) => logger.warn(`Discord: ${msg}`));
  client.on(Events.ShardDisconnect, (_e, id) => logger.warn(`Shard ${id} disconnected`));
  client.on(Events.ShardResume, (id) => logger.info(`Shard ${id} resumed`));
  client.rest.on('rateLimited', (info) =>
    logger.warn(`Rate limited on ${info.method} ${info.route}; retrying in ${info.retryAfter}ms`),
  );

  client.once(Events.ClientReady, async (c) => {
    logger.info(`Logged in as ${c.user.tag}`);
    const guild = await c.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) {
      logger.error(
        `The bot is not a member of DISCORD_GUILD_ID ${config.guildId}. Invite it to that server and restart.`,
      );
      await shutdown('invalid guild', 1);
      return;
    }
    logger.info(`Serving server "${guild.name}"`);
    for (const [name, id] of [
      ['BETTING_CHANNEL_ID', config.bettingChannelId],
      ['MARKET_ANNOUNCEMENT_CHANNEL_ID', config.announcementChannelId],
    ]) {
      const { problem } = await getPostableChannel(c, config.guildId, id);
      if (problem) logger.error(`${name}: ${problem}. Related features will fail until this is fixed.`);
    }
    await scheduler.start();
    logger.info('Scheduler started; startup reconciliation complete.');
  });

  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})...`);
    try {
      await scheduler.stop();
    } catch (err) {
      logger.error('Error while stopping scheduler:', err);
    }
    await client.destroy().catch(() => {});
    try {
      db.close();
    } catch (err) {
      logger.error('Error while closing database:', err);
    }
    logger.info('Goodbye.');
    process.exit(code);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('Unhandled promise rejection:', err));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    shutdown('uncaught exception', 1);
  });

  try {
    await client.login(config.token);
  } catch (err) {
    const hint =
      err.code === 'TokenInvalid'
        ? 'DISCORD_TOKEN was rejected by Discord. Reset the token in the Developer Portal.'
        : /disallowed intents/i.test(err.message)
          ? 'Enable "Server Members Intent" for the bot in the Developer Portal (Bot -> Privileged Gateway Intents).'
          : err.message;
    logger.error(`Login failed: ${hint}`);
    await shutdown('login failed', 1);
  }
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
