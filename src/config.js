'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SNOWFLAKE_RE = /^\d{17,20}$/;

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Loads `.env` from the project root into process.env (existing variables win). */
function loadDotEnv(file = path.resolve(__dirname, '..', '.env')) {
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds and validates the configuration object.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ require?: string[] }} [options] which Discord variables are mandatory
 */
function loadConfig(env = process.env, options = {}) {
  const required = options.require ?? [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'BETTING_CHANNEL_ID',
    'MARKET_ANNOUNCEMENT_CHANNEL_ID',
  ];
  const problems = [];

  const str = (name) => (env[name] ?? '').trim();

  for (const name of required) {
    if (!str(name)) problems.push(`${name} is required but missing or empty.`);
  }

  for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'BETTING_CHANNEL_ID', 'MARKET_ANNOUNCEMENT_CHANNEL_ID']) {
    const value = str(name);
    if (value && !SNOWFLAKE_RE.test(value)) {
      problems.push(`${name} must be a Discord ID (17-20 digits), got "${value}".`);
    }
  }

  const token = str('DISCORD_TOKEN');
  if (token && token.split('.').length !== 3) {
    problems.push('DISCORD_TOKEN does not look like a bot token (expected three dot-separated parts).');
  }

  const int = (name, def, { min = 0, max = 1_000_000_000 } = {}) => {
    const raw = str(name);
    if (!raw) return def;
    if (!/^\d+$/.test(raw)) {
      problems.push(`${name} must be a whole number, got "${raw}".`);
      return def;
    }
    const value = Number(raw);
    if (value < min || value > max) {
      problems.push(`${name} must be between ${min} and ${max}, got ${value}.`);
      return def;
    }
    return value;
  };

  const timezone = str('TIMEZONE') || 'Europe/Berlin';
  if (!isValidTimeZone(timezone)) problems.push(`TIMEZONE "${timezone}" is not a valid IANA time zone.`);

  const logLevel = (str('LOG_LEVEL') || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of debug, info, warn, error; got "${logLevel}".`);
  }

  const config = {
    token,
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
    bettingChannelId: str('BETTING_CHANNEL_ID'),
    announcementChannelId: str('MARKET_ANNOUNCEMENT_CHANNEL_ID'),
    databasePath: path.resolve(str('DATABASE_PATH') || './data/prediction-market.sqlite'),
    initialBalance: int('INITIAL_BALANCE', 1000, { min: 0 }),
    dailyReward: int('DAILY_REWARD', 200, { min: 0 }),
    minBet: int('MIN_BET', 10, { min: 1 }),
    leaderboardPageSize: int('LEADERBOARD_PAGE_SIZE', 10, { min: 1, max: 25 }),
    timezone,
    dailyMaxBackfillDays: int('DAILY_MAX_BACKFILL_DAYS', 7, { min: 1, max: 60 }),
    logLevel,
  };

  if (config.bettingChannelId && config.bettingChannelId === config.announcementChannelId) {
    // Allowed, but worth knowing: announcements then land in the betting channel.
    config.sameChannel = true;
  }

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}

module.exports = { loadConfig, loadDotEnv, ConfigError, SNOWFLAKE_RE };
