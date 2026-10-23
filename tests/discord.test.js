'use strict';

/**
 * Drives the real interaction handler, publisher and notifier with fake Discord
 * objects (no network). Verifies routing, channel rules, the button -> modal ->
 * confirm betting flow, resolution, embeds and announcements end to end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { setup, uid, balance, assertLedgerConsistent, GUILD, BETTING, ANNOUNCE, HOUR } = require('./helpers');
const { createInteractionHandler } = require('../src/handlers/interactionHandler');
const { MarketPublisher } = require('../src/discord/marketPublisher');
const { Notifier } = require('../src/discord/notifier');
const { ids } = require('../src/discord/customIds');

let snowflake = 1_300_000_000_000_000_000n;
const nextId = () => String(++snowflake);
const json = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

function fakeDiscord() {
  const sent = { [BETTING]: [], [ANNOUNCE]: [] };
  const edits = [];
  const dms = [];
  const guild = {
    id: GUILD,
    name: 'Test server',
    members: {
      me: { id: 'bot' },
      cache: new Map(),
      fetchMe: async () => ({ id: 'bot' }),
      fetch: async () => new Map(),
    },
    channels: { cache: new Map() },
  };
  const channel = (id) => ({
    id,
    guildId: GUILD,
    guild,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      const message = { id: nextId(), payload };
      sent[id].push(message);
      return message;
    },
    messages: {
      edit: async (messageId, payload) => {
        if (!sent[id].some((m) => m.id === messageId)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        edits.push({ messageId, payload });
      },
    },
  });
  const channels = { [BETTING]: channel(BETTING), [ANNOUNCE]: channel(ANNOUNCE) };
  const client = {
    channels: { fetch: async (id) => channels[id] ?? null },
    guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild },
    users: {
      fetch: async (id) => ({ id, send: async (payload) => dms.push({ id, payload }) }),
    },
  };
  return { client, sent, edits, dms };
}

class FakeInteraction {
  constructor({ kind, user = uid(2), channelId = BETTING, guildId = GUILD, admin = false, commandName, sub, group, options = {}, customId, fields = {}, focused }) {
    this.id = nextId();
    this.kind = kind;
    this.user = { id: user, username: `user${user.slice(-2)}`, bot: false, displayAvatarURL: () => 'https://cdn.example/a.png' };
    this.member = { displayName: `Member ${user.slice(-2)}` };
    this.channelId = channelId;
    this.guildId = guildId;
    this.channel = { isThread: () => false };
    this.memberPermissions = { has: (flag) => admin && flag === PermissionFlagsBits.Administrator };
    this.commandName = commandName;
    this.customId = customId;
    this.calls = [];
    this.replied = false;
    this.deferred = false;
    const opt = options;
    this.options = {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group ?? null,
      getString: (n) => opt[n] ?? null,
      getInteger: (n) => opt[n] ?? null,
      getUser: (n) => (opt[n] ? { id: opt[n], bot: false, username: 'target', displayAvatarURL: () => 'https://cdn.example/b.png' } : null),
      get: (n) => (n in opt ? { value: opt[n] } : null),
      getFocused: () => focused,
    };
    this.fields = { getTextInputValue: (id) => fields[id] ?? '' };
  }
  isChatInputCommand() { return this.kind === 'command'; }
  isAutocomplete() { return this.kind === 'autocomplete'; }
  isModalSubmit() { return this.kind === 'modal'; }
  isMessageComponent() { return this.kind === 'button'; }
  isButton() { return this.kind === 'button'; }
  async reply(p) { this.replied = true; this.calls.push(['reply', p]); }
  async deferReply(p) { this.deferred = true; this.calls.push(['deferReply', p]); }
  async editReply(p) { this.replied = true; this.calls.push(['editReply', p]); }
  async followUp(p) { this.calls.push(['followUp', p]); }
  async update(p) { this.replied = true; this.calls.push(['update', p]); }
  async showModal(m) { this.replied = true; this.calls.push(['showModal', json(m)]); }
  async respond(c) { this.responded = true; this.calls.push(['respond', c]); }
  last() { return this.calls.at(-1); }
  text() {
    const [, p] = this.last();
    return [p?.content ?? '', ...(p?.embeds ?? []).map((e) => JSON.stringify(json(e)))].join('\n');
  }
  components() {
    return (this.last()[1].components ?? []).flatMap((row) => json(row).components);
  }
}

function harness() {
  const env = setup({ now: Date.UTC(2026, 9, 23, 10, 0, 0) });
  const discord = fakeDiscord();
  const publisher = new MarketPublisher(discord.client, env.services, env.config);
  const notifier = new Notifier(discord.client, env.services, env.config);
  const ctx = { client: discord.client, config: env.config, services: env.services, publisher, notifier, scheduler: null };
  const handle = createInteractionHandler(ctx);
  const run = async (opts) => {
    const i = new FakeInteraction(opts);
    await handle(i);
    await Promise.all([...publisher.inflight.values()]);
    if (notifier.running) await notifier.running;
    return i;
  };
  return { ...env, ...discord, publisher, notifier, run };
}

const createCmd = (extra = {}) => ({
  kind: 'command',
  commandName: 'market',
  sub: 'create',
  user: uid(1),
  options: { question: 'Will it snow in Berlin on Christmas?', outcome_a: 'YES', outcome_b: 'NO', duration: '1h', ...extra },
});

test('commands outside the betting channel get an ephemeral redirect', async () => {
  const h = harness();
  const i = await h.run({ kind: 'command', commandName: 'balance', channelId: ANNOUNCE });
  assert.equal(i.last()[0], 'reply');
  assert.ok(i.last()[1].flags, 'ephemeral');
  assert.match(i.text(), new RegExp(`Please use bot commands in <#${BETTING}>`));
  assert.equal(h.services.users.getUser(uid(2)), null, 'nothing was executed');

  const other = await h.run({ kind: 'command', commandName: 'balance', guildId: '900000000000000077' });
  assert.match(other.text(), /home server/);
});

test('/market create publishes the market with bet buttons in the announcement channel', async () => {
  const h = harness();
  const i = await h.run(createCmd());
  assert.match(i.text(), /Market #1 created/);
  assert.equal(h.sent[ANNOUNCE].length, 1);
  assert.equal(h.sent[BETTING].length, 0, 'not posted in the command channel');
  const msg = h.sent[ANNOUNCE][0];
  const embed = json(msg.payload.embeds[0]);
  assert.match(embed.title, /Market #1 · Will it snow/);
  assert.ok(embed.fields.some((f) => f.name === 'Total volume'));
  const buttons = json(msg.payload.components[0]).components;
  assert.deepEqual(buttons.map((b) => b.custom_id), [ids.bet(1, 0), ids.bet(1, 1), ids.position(1)]);
  const market = h.services.markets.getMarket(1);
  assert.equal(market.announcement_message_id, msg.id);
  assert.equal(market.synced_version, market.sync_version);
});

test('/market create without options opens the creation modal; submitting it creates the market', async () => {
  const h = harness();
  const i = await h.run({ kind: 'command', commandName: 'market', sub: 'create', user: uid(1), options: {} });
  assert.equal(i.last()[0], 'showModal');
  assert.equal(i.last()[1].custom_id, ids.createModal());
  assert.equal(i.last()[1].components.length, 5);

  const submit = await h.run({
    kind: 'modal',
    user: uid(1),
    customId: ids.createModal(),
    fields: { question: 'Modal market question?', outcome_a: 'Up', outcome_b: 'Down', duration: '2d', description: '' },
  });
  assert.match(submit.text(), /Market #1 created/);
  assert.equal(h.sent[ANNOUNCE].length, 1);

  const bad = await h.run({
    kind: 'modal',
    user: uid(1),
    customId: ids.createModal(),
    fields: { question: 'Another market?', outcome_a: 'A', outcome_b: 'B', duration: 'forever' },
  });
  assert.match(bad.text(), /Invalid duration/);
});

test('button -> modal -> confirm places exactly one bet and refreshes the embed', async () => {
  const h = harness();
  await h.run(createCmd());
  // Click "Bet: YES" in the announcement channel.
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, customId: ids.bet(1, 0) });
  assert.equal(click.last()[0], 'showModal');
  assert.equal(click.last()[1].custom_id, ids.betModal(1, 0));

  // Submit the stake: nothing is charged yet, a confirmation is shown.
  const modal = await h.run({ kind: 'modal', channelId: ANNOUNCE, customId: ids.betModal(1, 0), fields: { stake: '250' } });
  assert.match(modal.text(), /Confirm your bet/);
  assert.equal(balance(h.services, uid(2)), 1000);
  const confirmId = modal.components()[0].custom_id;
  assert.match(confirmId, /^pm:cf:/);

  // Someone else cannot confirm it.
  const thief = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(3), customId: confirmId });
  assert.match(thief.text(), /Only the person who started/);

  const confirm = await h.run({ kind: 'button', channelId: ANNOUNCE, customId: confirmId });
  assert.equal(confirm.last()[0], 'update');
  assert.match(confirm.text(), /Bet placed/);
  assert.equal(balance(h.services, uid(2)), 750);
  assert.ok(h.edits.length >= 1, 'announcement embed edited');
  assert.match(JSON.stringify(json(h.edits.at(-1).payload.embeds[0])), /250 pts/);

  // Double click: no second charge.
  const again = await h.run({ kind: 'button', channelId: ANNOUNCE, customId: confirmId });
  assert.match(again.text(), /already confirmed/);
  assert.equal(balance(h.services, uid(2)), 750);

  // Invalid stakes are rejected at the modal step.
  const low = await h.run({ kind: 'modal', channelId: ANNOUNCE, customId: ids.betModal(1, 1), fields: { stake: '5' } });
  assert.match(low.text(), /minimum bet is 10/);
  const tooMuch = await h.run({ kind: 'modal', channelId: ANNOUNCE, customId: ids.betModal(1, 1), fields: { stake: '751' } });
  assert.match(tooMuch.text(), /Insufficient balance/);
});

test('stale bet buttons after expiry are rejected and the embed shows betting closed', async () => {
  const h = harness();
  await h.run(createCmd());
  h.advance(HOUR);
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, customId: ids.bet(1, 0) });
  assert.match(click.text(), /closed/);
  assert.notEqual(click.last()[0], 'showModal');

  h.services.markets.closeExpiredMarkets();
  await h.publisher.syncAll();
  const buttons = json(h.edits.at(-1).payload.components[0]).components;
  assert.ok(buttons.filter((b) => b.custom_id.startsWith('pm:bet:')).every((b) => b.disabled));
  assert.match(JSON.stringify(json(h.edits.at(-1).payload.embeds[0])), /Betting closed/);

  await h.notifier.dispatch();
  assert.equal(h.dms.length, 1);
  assert.equal(h.dms[0].id, uid(1));
  assert.match(JSON.stringify(json(h.dms[0].payload.embeds[0])), /market resolve market_id:1/);
  await h.notifier.dispatch();
  assert.equal(h.dms.length, 1, 'no duplicate reminder');
});

test('/market bet, /market resolve with confirmation, result announcement', async () => {
  const h = harness();
  await h.run(createCmd());
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'YES', amount: 100 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(3), options: { market_id: 1, outcome: 'no', amount: 300 } });
  assert.equal(balance(h.services, uid(3)), 700);

  const early = await h.run({ kind: 'command', commandName: 'market', sub: 'resolve', user: uid(1), options: { market_id: 1, outcome: 'YES' } });
  assert.match(early.text(), /still open/);

  h.advance(HOUR);
  const notCreator = await h.run({ kind: 'command', commandName: 'market', sub: 'resolve', user: uid(2), options: { market_id: 1, outcome: 'YES' } });
  assert.match(notCreator.text(), /Only the creator/);

  const prep = await h.run({ kind: 'command', commandName: 'market', sub: 'resolve', user: uid(1), options: { market_id: 1, outcome: 'YES' } });
  assert.match(prep.text(), /This is final/);
  assert.equal(h.services.markets.getMarket(1).status, 'OPEN', 'nothing happens before confirmation');

  const confirm = await h.run({ kind: 'button', user: uid(1), customId: prep.components()[0].custom_id });
  assert.match(confirm.text(), /resolved/);
  assert.equal(balance(h.services, uid(2)), 900 + 400);
  assert.equal(balance(h.services, uid(3)), 700);

  const announcement = h.sent[ANNOUNCE].at(-1);
  assert.match(JSON.stringify(json(announcement.payload.embeds[0])), /resolved: YES/);
  assert.equal(announcement.payload.reply.messageReference, h.services.markets.getMarket(1).announcement_message_id);
  assert.match(JSON.stringify(json(h.edits.at(-1).payload.embeds[0])), /winner/);
  assertLedgerConsistent(assert, h.db);
});

test('admin commands: permission check, points, cancel with audit, stats, daily status', async () => {
  const h = harness();
  const denied = await h.run({ kind: 'command', commandName: 'admin', sub: 'stats', group: null });
  assert.match(denied.text(), /Administrator permission/);

  const admin = { kind: 'command', commandName: 'admin', user: uid(9), admin: true, channelId: '900000000000000055' };
  const add = await h.run({ ...admin, group: 'points', sub: 'add', options: { user: uid(4), amount: 500, reason: 'event prize' } });
  assert.match(add.text(), /1,500 pts/);
  const remove = await h.run({ ...admin, group: 'points', sub: 'remove', options: { user: uid(4), amount: 2000, reason: 'oops' } });
  assert.match(remove.text(), /never go negative/);
  assert.equal(balance(h.services, uid(4)), 1500);

  await h.run(createCmd());
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'YES', amount: 100 } });
  const prep = await h.run({ ...admin, group: 'market', sub: 'cancel', options: { market_id: 1, reason: 'duplicate market' } });
  const done = await h.run({ ...admin, kind: 'button', channelId: BETTING, customId: prep.components()[0].custom_id });
  assert.match(done.text(), /cancelled/);
  assert.equal(balance(h.services, uid(2)), 1000);
  assert.match(JSON.stringify(json(h.sent[ANNOUNCE].at(-1).payload.embeds[0])), /cancelled/);

  const actions = h.db.prepare('SELECT action FROM audit_logs ORDER BY id').pluck().all();
  assert.deepEqual(actions, ['ADMIN_POINTS_ADD', 'ADMIN_MARKET_CANCEL']);

  const stats = await h.run({ ...admin, sub: 'stats' });
  assert.match(stats.text(), /Ledger check: OK/);
  const daily = await h.run({ ...admin, sub: 'daily-distribution' });
  assert.match(daily.text(), /Daily reward distribution/);
});

test('leaderboard pagination, list, view, profile, history and help render', async () => {
  const h = harness();
  for (let n = 1; n <= 12; n++) h.services.users.ensureUser(uid(n), `player${n}`);
  h.services.users.applyTransaction(uid(7), 50, { type: 'ADMIN_GRANT', key: 'g7' });
  const lb = await h.run({ kind: 'command', commandName: 'leaderboard', user: uid(1) });
  assert.match(lb.text(), /🥇/);
  assert.match(lb.text(), /player7/, 'richest first');
  assert.match(lb.text(), /\(left\)/, 'members no longer in the server fall back to the stored name');
  const next = lb.components().find((b) => b.label === 'Next ▶');
  const page2 = await h.run({ kind: 'button', user: uid(1), customId: next.custom_id });
  assert.equal(page2.last()[0], 'update');
  assert.match(page2.text(), /Page 2\/2/);
  const foreign = await h.run({ kind: 'button', user: uid(2), customId: next.custom_id });
  assert.match(foreign.text(), /your own copy/);

  await h.run(createCmd());
  for (const [sub, options] of [['list', {}], ['view', { market_id: 1 }], ['history', {}]]) {
    const i = await h.run({ kind: 'command', commandName: 'market', sub, options });
    assert.doesNotMatch(i.text(), /Something went wrong/, sub);
  }
  for (const commandName of ['profile', 'balance', 'help']) {
    const i = await h.run({ kind: 'command', commandName });
    assert.doesNotMatch(i.text(), /Something went wrong/, commandName);
  }

  const ac = await h.run({ kind: 'autocomplete', commandName: 'market', sub: 'bet', focused: { name: 'market_id', value: '' } });
  assert.deepEqual(ac.last()[1].map((c) => c.value), [1]);
  const acOutcome = await h.run({ kind: 'autocomplete', commandName: 'market', sub: 'bet', options: { market_id: 1 }, focused: { name: 'outcome', value: 'y' } });
  assert.deepEqual(acOutcome.last()[1].map((c) => c.value), ['YES']);
});

test('a deleted announcement message is reposted for open markets', async () => {
  const h = harness();
  await h.run(createCmd());
  const firstId = h.services.markets.getMarket(1).announcement_message_id;
  h.sent[ANNOUNCE].length = 0; // simulate deletion
  h.services.markets.touch(1);
  await h.publisher.sync(1);
  const market = h.services.markets.getMarket(1);
  assert.notEqual(market.announcement_message_id, firstId);
  assert.equal(h.sent[ANNOUNCE].length, 1);
});

test('unexpected errors are reported generically without leaking details', async () => {
  const h = harness();
  h.services.stats.profile = () => {
    throw new Error('SQLITE internal detail /secret/path');
  };
  const i = await h.run({ kind: 'command', commandName: 'profile' });
  assert.match(i.text(), /Something went wrong on our side/);
  assert.doesNotMatch(i.text(), /secret/);
});
