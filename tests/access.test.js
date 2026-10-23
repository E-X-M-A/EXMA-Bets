'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAccess, SeenSet } = require('../src/handlers/accessControl');
const { parseCustomId, ids } = require('../src/discord/customIds');
const { loadConfig, ConfigError } = require('../src/config');
const { baseConfig, GUILD, BETTING, ANNOUNCE } = require('./helpers');

const OTHER = '900000000000000099';
const check = (o) => checkAccess(baseConfig, { guildId: GUILD, ...o });

test('normal commands only work in the betting channel', () => {
  assert.equal(check({ channelId: BETTING, kind: 'command' }), null);
  assert.match(check({ channelId: ANNOUNCE, kind: 'command' }), new RegExp(`<#${BETTING}>`));
  assert.match(check({ channelId: OTHER, kind: 'command' }), /Please use bot commands/);
  assert.equal(check({ channelId: OTHER, parentChannelId: BETTING, kind: 'command' }), null, 'threads of the betting channel are fine');
});

test('commands outside the configured server or in DMs are rejected', () => {
  assert.match(checkAccess(baseConfig, { guildId: OTHER, channelId: BETTING, kind: 'command' }), /home server/);
  assert.match(checkAccess(baseConfig, { guildId: null, channelId: BETTING, kind: 'command' }), /home server/);
  assert.match(checkAccess(baseConfig, { guildId: OTHER, channelId: ANNOUNCE, kind: 'component' }), /home server/);
});

test('market buttons work in the announcement and betting channels only', () => {
  assert.equal(check({ channelId: ANNOUNCE, kind: 'component' }), null);
  assert.equal(check({ channelId: BETTING, kind: 'component' }), null);
  assert.equal(check({ channelId: ANNOUNCE, kind: 'modal' }), null);
  assert.ok(check({ channelId: OTHER, kind: 'component' }));
});

test('admin commands need the Administrator permission but work in any channel', () => {
  assert.equal(check({ channelId: OTHER, kind: 'command', scope: 'admin', isAdmin: true }), null);
  assert.match(check({ channelId: BETTING, kind: 'command', scope: 'admin', isAdmin: false }), /Administrator/);
});

test('custom ids round-trip and reject tampered input', () => {
  assert.deepEqual(parseCustomId(ids.bet(12, 1)), { type: 'bet', args: ['12', '1'] });
  assert.deepEqual(parseCustomId(ids.leaderboard('profit', 3, GUILD)), { type: 'leaderboard', args: ['profit', '3', GUILD] });
  assert.equal(parseCustomId('pm:bet:12:1; DROP TABLE users'), null);
  assert.equal(parseCustomId('pm:lb:evil:1:' + GUILD), null);
  assert.equal(parseCustomId('pm:ml:OPEN OR 1=1:1:' + GUILD), null);
  assert.equal(parseCustomId('something-else'), null);
  assert.equal(parseCustomId('x'.repeat(200)), null);
});

test('duplicate interaction ids are detected', () => {
  const seen = new SeenSet(3);
  assert.equal(seen.checkAndAdd('1'), false);
  assert.equal(seen.checkAndAdd('1'), true);
  for (const id of ['2', '3', '4']) seen.checkAndAdd(id);
  assert.equal(seen.checkAndAdd('1'), false, 'oldest entries are evicted');
});

test('configuration validation reports every problem clearly', () => {
  assert.throws(
    () => loadConfig({ DISCORD_CLIENT_ID: 'abc', BETTING_CHANNEL_ID: '123', MIN_BET: '-5', TIMEZONE: 'Mars/Base' }),
    (err) =>
      err instanceof ConfigError &&
      err.problems.some((p) => p.includes('DISCORD_TOKEN is required')) &&
      err.problems.some((p) => p.includes('DISCORD_CLIENT_ID must be a Discord ID')) &&
      err.problems.some((p) => p.includes('BETTING_CHANNEL_ID must be a Discord ID')) &&
      err.problems.some((p) => p.includes('MIN_BET')) &&
      err.problems.some((p) => p.includes('TIMEZONE')),
  );
  const ok = loadConfig({
    DISCORD_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccccccc',
    DISCORD_CLIENT_ID: '100000000000000001',
    DISCORD_GUILD_ID: GUILD,
    BETTING_CHANNEL_ID: BETTING,
    MARKET_ANNOUNCEMENT_CHANNEL_ID: ANNOUNCE,
  });
  assert.equal(ok.initialBalance, 1000);
  assert.equal(ok.dailyReward, 200);
  assert.equal(ok.minBet, 10);
  assert.equal(ok.timezone, 'Europe/Berlin');
});
