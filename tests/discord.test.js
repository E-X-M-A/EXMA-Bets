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
  const closedDms = new Set();
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
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          if (closedDms.has(id)) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
          dms.push({ id, payload });
        },
      }),
    },
  };
  return { client, sent, edits, dms, closedDms };
}

class FakeInteraction {
  constructor({ kind, user = uid(2), channelId = BETTING, guildId = GUILD, admin = false, commandName, sub, group, options = {}, customId, fields = {}, focused, values = [] }) {
    this.values = values;
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
  isMessageComponent() { return this.kind === 'button' || this.kind === 'select'; }
  isStringSelectMenu() { return this.kind === 'select'; }
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
  assert.deepEqual(buttons.map((b) => b.custom_id), [ids.bet(1, 0), ids.bet(1, 1), ids.position(1), ids.bets(1)]);
  const market = h.services.markets.getMarket(1);
  assert.equal(market.announcement_message_id, msg.id);
  assert.equal(market.synced_version, market.sync_version);
});

test('/market create without options opens the creation modal; submitting it creates the market', async () => {
  const h = harness();
  const i = await h.run({ kind: 'command', commandName: 'market', sub: 'create', user: uid(1), options: {} });
  assert.equal(i.last()[0], 'showModal');
  assert.equal(i.last()[1].custom_id, ids.createModal());
  assert.equal(i.last()[1].components.length, 4, 'question, outcomes, duration, description');

  const submit = await h.run({
    kind: 'modal',
    user: uid(1),
    customId: ids.createModal(),
    fields: { question: 'Modal market question?', outcomes: 'Up\nDown', duration: '2d', description: '' },
  });
  assert.match(submit.text(), /Market #1 created/);
  assert.equal(h.sent[ANNOUNCE].length, 1);

  const bad = await h.run({
    kind: 'modal',
    user: uid(1),
    customId: ids.createModal(),
    fields: { question: 'Another market?', outcomes: 'A\nB', duration: 'forever' },
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

  // No separate result post: the market message itself shows the result.
  assert.equal(h.sent[ANNOUNCE].length, 1, 'only the original market message');
  const resolved = JSON.stringify(json(h.edits.at(-1).payload.embeds[0]));
  assert.match(resolved, /Resolved:\*\* YES/);
  assert.match(resolved, /winner/);
  assert.match(resolved, /1 winner shared \*\*400 pts\*\*; 1 bettor lost\./);
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
  assert.equal(h.sent[ANNOUNCE].length, 1, 'no separate cancellation post');
  assert.match(JSON.stringify(json(h.edits.at(-1).payload.embeds[0])), /Cancelled\*\* · all stakes refunded\\nReason: duplicate market/);

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

/* ---------------------------------------------------------------------------
 * Resolving with buttons + per-bettor results on the market message
 * ------------------------------------------------------------------------- */

const embedText = (payload) => JSON.stringify(json(payload.embeds[0]));
const lastMarketEdit = (h) => h.edits.at(-1).payload;
const resolveButtons = (payload) =>
  (payload.components ?? []).flatMap((r) => json(r).components).filter((b) => b.custom_id.startsWith('pm:res:'));

async function closedMarketWithBets(h) {
  await h.run(createCmd());
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'YES', amount: 100 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(3), options: { market_id: 1, outcome: 'YES', amount: 300 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(4), options: { market_id: 1, outcome: 'NO', amount: 200 } });
  assert.equal(resolveButtons(lastMarketEdit(h)).length, 0, 'no resolve buttons while betting is open');
  h.advance(HOUR);
  h.services.markets.closeExpiredMarkets();
  await h.publisher.syncAll();
}

test('after betting closes the market message offers one resolve button per outcome', async () => {
  const h = harness();
  await closedMarketWithBets(h);
  const buttons = resolveButtons(lastMarketEdit(h));
  assert.deepEqual(buttons.map((b) => b.custom_id), [ids.resolve(1, 0), ids.resolve(1, 1)]);
  assert.deepEqual(buttons.map((b) => b.label), ['Resolve: YES', 'Resolve: NO']);
  assert.match(embedText(lastMarketEdit(h)), /pick the result with the buttons below/);
});

test('the creator resolves with a button; every bettor sees their result on the market message', async () => {
  const h = harness();
  await closedMarketWithBets(h);

  const stranger = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(2), customId: ids.resolve(1, 0) });
  assert.match(stranger.text(), /Only the market creator/);
  assert.equal(h.services.markets.getMarket(1).status, 'AWAITING_RESOLUTION');

  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  assert.match(click.text(), /Winning outcome: \*\*YES\*\*/);
  assert.match(click.text(), /This is final/);
  assert.equal(h.services.markets.getMarket(1).status, 'AWAITING_RESOLUTION', 'nothing happens before confirming');

  const confirm = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });
  assert.match(confirm.text(), /resolved/);
  assert.equal(h.services.markets.getMarket(1).status, 'RESOLVED');

  // YES pool 400, NO pool 200: uid2 100 -> 150 (+50), uid3 300 -> 450 (+150), uid4 loses 200.
  const payload = lastMarketEdit(h);
  const embed = json(payload.embeds[0]);
  const results = embed.fields.filter((f) => f.name.startsWith('Results'));
  assert.equal(results[0].name, 'Results · 2 won, 1 lost');
  const lines = results.flatMap((f) => f.value.split('\n'));
  assert.deepEqual(lines, [
    `✅ <@${uid(3)}> won **+150 pts** (staked 300 pts, paid 450 pts)`,
    `✅ <@${uid(2)}> won **+50 pts** (staked 100 pts, paid 150 pts)`,
    `❌ <@${uid(4)}> lost **200 pts**`,
  ]);
  assert.equal(resolveButtons(payload).length, 0, 'resolve buttons removed after resolution');
  assert.deepEqual(payload.allowedMentions, { parse: [] }, 'listing bettors does not ping them');

  // A stale resolve button cannot settle twice.
  const again = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 1) });
  assert.match(again.text(), /already resolved/);
  assert.equal(balance(h.services, uid(3)), 1150);
  assertLedgerConsistent(assert, h.db);
});

test('an administrator resolves with a button after giving a reason', async () => {
  const h = harness();
  await closedMarketWithBets(h);
  const admin = { channelId: ANNOUNCE, user: uid(9), admin: true };

  const click = await h.run({ ...admin, kind: 'button', customId: ids.resolve(1, 1) });
  assert.equal(click.last()[0], 'showModal');
  assert.equal(click.last()[1].custom_id, ids.resolveModal(1, 1));

  const notAdmin = await h.run({ kind: 'modal', channelId: ANNOUNCE, user: uid(2), customId: ids.resolveModal(1, 1), fields: { reason: 'sneaky' } });
  assert.match(notAdmin.text(), /Administrator permission/);

  const modal = await h.run({ ...admin, kind: 'modal', customId: ids.resolveModal(1, 1), fields: { reason: 'Creator left; checked source' } });
  assert.match(modal.text(), /Administrator resolution/);
  assert.match(modal.text(), /Creator left; checked source/);
  const confirm = await h.run({ ...admin, kind: 'button', customId: modal.components()[0].custom_id });
  assert.match(confirm.text(), /resolved/);

  const market = h.services.markets.getMarket(1);
  assert.equal(market.winning_outcome, 1);
  assert.equal(market.resolved_by_admin, 1);
  const log = h.db.prepare("SELECT reason FROM audit_logs WHERE action = 'ADMIN_MARKET_RESOLVE'").get();
  assert.equal(log.reason, 'Creator left; checked source');
  // NO pool 200 wins the YES pool 400: uid4 gets 600 back.
  assert.match(embedText(lastMarketEdit(h)), /won \*\*\+400 pts\*\*/);
  assert.equal(balance(h.services, uid(4)), 1400);
});

test('resolve buttons cannot be used before the deadline, even if forged', async () => {
  const h = harness();
  await h.run(createCmd());
  const creator = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  assert.match(creator.text(), /still open/);
  const admin = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(9), admin: true, customId: ids.resolve(1, 0) });
  assert.match(admin.text(), /still open/);
  assert.notEqual(admin.last()[0], 'showModal');
});

test('refunds and no-bet markets are described in the results', async () => {
  const views = require('../src/discord/views');
  const refund = views.resultFields({ refunded: 1, payouts: [{ user_id: uid(2), staked: 100, paid: 100 }] });
  assert.equal(refund[0].name, 'Results · all 1 bettor refunded');
  assert.equal(refund[0].value, `↩️ <@${uid(2)}> refunded 100 pts`);
  const none = views.resultFields({ refunded: 0, payouts: [] });
  assert.match(none[0].value, /No bets were placed/);
  const mixed = views.resultFields({ refunded: 0, payouts: [{ user_id: uid(2), staked: 300, paid: 200 }] });
  assert.equal(mixed[0].value, `❌ <@${uid(2)}> lost **100 pts** (staked 300 pts, got 200 pts back)`);
});

test('results are paginated: page 1 on the market message, private pageable copy via "All results"', async () => {
  const h = harness();
  await h.run(createCmd());
  // 25 bettors: 13 on YES, 12 on NO -> 3 pages of 10.
  for (let n = 10; n < 35; n++) {
    await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(n), options: { market_id: 1, outcome: n % 2 ? 'NO' : 'YES', amount: 10 + n } });
  }
  h.advance(HOUR);
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });

  // Shared market message: only page 1, plus an "All results" button.
  const payload = lastMarketEdit(h);
  const embed = json(payload.embeds[0]);
  const results = embed.fields.filter((f) => f.name.startsWith('Results'));
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Results · 13 won, 12 lost (page 1/3)');
  assert.equal(results[0].value.split('\n').filter((l) => /^[✅❌]/.test(l)).length, 10);
  assert.match(results[0].value, /Showing 10 of 25/);
  const allButton = payload.components.flatMap((r) => json(r).components).find((b) => b.custom_id === ids.results(1));
  assert.equal(allButton.label, 'All results (25)');

  // Clicking it opens a private copy (ephemeral reply), page 1, with the viewer's own result pinned.
  const viewer = uid(33); // a NO bettor: lost
  const open = await h.run({ kind: 'button', channelId: ANNOUNCE, user: viewer, customId: ids.results(1) });
  assert.equal(open.last()[0], 'reply');
  assert.ok(open.last()[1].flags, 'ephemeral');
  assert.match(open.text(), new RegExp(`Your result:\\*\\* ❌ <@${viewer}> lost`));
  assert.match(open.text(), /Page 1\/3 · 25 bettors/);
  const next = open.components().find((b) => b.label === 'Next ▶');
  assert.equal(next.custom_id, ids.resultsPage(1, 2));

  // Paging updates only that private message; the shared message is untouched.
  const editsBefore = h.edits.length;
  const seen = new Set();
  for (let page = 1; page <= 3; page++) {
    const i = await h.run({ kind: 'button', channelId: ANNOUNCE, user: viewer, customId: ids.resultsPage(1, page) });
    assert.equal(i.last()[0], 'update');
    assert.match(i.text(), new RegExp(`Page ${page}/3`));
    const lines = json(i.last()[1].embeds[0]).description.split('\n\n').at(-1).split('\n');
    assert.equal(lines.length, page < 3 ? 10 : 5);
    for (const l of lines) seen.add(l.match(/<@(\d+)>/)[1]);
  }
  assert.equal(seen.size, 25, 'every bettor appears exactly once across pages');
  assert.equal(h.edits.length, editsBefore);

  // Out-of-range pages are clamped; unresolved markets have no results.
  const far = await h.run({ kind: 'button', channelId: ANNOUNCE, user: viewer, customId: ids.resultsPage(1, 99) });
  assert.match(far.text(), /Page 3\/3/);
  await h.run(createCmd({ question: 'Another open market?' }));
  const early = await h.run({ kind: 'button', channelId: ANNOUNCE, user: viewer, customId: ids.results(2) });
  assert.match(early.text(), /no results yet/);

  // /market view shows page 1 and the same button.
  const view = await h.run({ kind: 'command', commandName: 'market', sub: 'view', user: viewer, options: { market_id: 1 } });
  assert.match(view.text(), /page 1\/3/);
  assert.ok(view.components().some((b) => b.custom_id === ids.results(1)));
});

test('small markets show all results on the message without an "All results" button', async () => {
  const h = harness();
  await closedMarketWithBets(h);
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });
  const payload = lastMarketEdit(h);
  assert.doesNotMatch(embedText(payload), /page 1\//);
  assert.ok(!payload.components.flatMap((r) => json(r).components).some((b) => b.custom_id === ids.results(1)));
});

test('a results page stays within Discord embed limits even with huge numbers', () => {
  const views = require('../src/discord/views');
  const payouts = Array.from({ length: 400 }, (_, i) => ({ user_id: uid(i + 1), staked: 999_999_999_999, paid: i % 2 ? 0 : 999_999_999_999 * 2 }));
  const market = {
    id: 1, question: 'Q'.repeat(200), description: 'D'.repeat(1000), status: 'RESOLVED', creator_id: uid(1),
    created_at: 0, expires_at: 1, resolved_at: 2, resolver_id: uid(1), resolved_by_admin: 0, winning_outcome: 0,
    outcomes: [{ idx: 0, label: 'Y'.repeat(50), pool: 1, bettors: 200, probability: 50, multiplier: 2 },
               { idx: 1, label: 'N'.repeat(50), pool: 1, bettors: 200, probability: 50, multiplier: 2 }],
    totalPool: 2, participants: 400,
  };
  const settlement = { refunded: 0, payouts };
  const data = views.marketEmbed(market, { now: 3, settlement }).toJSON();
  for (const f of data.fields) assert.ok(f.value.length <= 1024, `field ${f.name} is ${f.value.length} chars`);
  const total = data.title.length + data.description.length + data.footer.text.length +
    data.fields.reduce((a, f) => a + f.name.length + f.value.length, 0) + 'Your bets'.length + 1024;
  assert.ok(total <= 6000, `embed is ${total} chars`);
  const page = views.resultsView(market, settlement, 40, uid(2)).embeds[0].toJSON();
  assert.ok(page.description.length <= 4096);
  assert.match(page.footer.text, /Page 40\/40/);
});

test('every bettor gets a DM saying what they won or lost, exactly once', async () => {
  const h = harness();
  await closedMarketWithBets(h);
  h.closedDms.add(uid(4)); // has DMs disabled
  const dmsBefore = h.dms.length; // creator reminder

  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });

  const results = h.dms.slice(dmsBefore).map((d) => ({ id: d.id, embed: json(d.payload.embeds[0]) }));
  const byUser = Object.fromEntries(results.map((r) => [r.id, r.embed]));
  assert.deepEqual(Object.keys(byUser).sort(), [uid(2), uid(3)], 'winners DMed; closed-DM loser skipped without error');
  assert.equal(byUser[uid(2)].title, '✅ You won +50 pts!');
  assert.match(byUser[uid(2)].description, /staked 100 pts and received \*\*150 pts\*\*/);
  assert.match(byUser[uid(2)].description, /Your balance: \*\*1,050 pts\*\*/);
  assert.match(byUser[uid(2)].description, /Your bets: 100 pts on \*\*YES\*\*/);
  assert.equal(byUser[uid(3)].title, '✅ You won +150 pts!');
  assert.equal(results.filter((r) => r.id === uid(1)).length, 0, 'the creator did not bet, so no result DM');

  // The closed-DM notification is not retried forever and nothing is sent twice.
  const pending = h.db.prepare("SELECT COUNT(*) FROM notifications WHERE kind = 'BET_RESULT' AND status <> 'SENT'").pluck().get();
  assert.equal(pending, 0);
  await h.notifier.dispatch();
  assert.equal(h.dms.length, dmsBefore + 2);
});

test('losers and cancelled-market bettors get a DM with the amount', async () => {
  const h = harness();
  await closedMarketWithBets(h);
  const before = h.dms.length;
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 0) });
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });
  const loser = h.dms.slice(before).find((d) => d.id === uid(4));
  assert.equal(json(loser.payload.embeds[0]).title, '❌ You lost 200 pts');
  assert.match(json(loser.payload.embeds[0]).description, /Result: \*\*YES\*\*\. You staked 200 pts and lost it\./);

  const h2 = harness();
  await h2.run(createCmd());
  await h2.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'YES', amount: 120 } });
  const admin = { kind: 'command', commandName: 'admin', user: uid(9), admin: true };
  const prep = await h2.run({ ...admin, group: 'market', sub: 'cancel', options: { market_id: 1, reason: 'Question was ambiguous' } });
  await h2.run({ ...admin, kind: 'button', customId: prep.components()[0].custom_id });
  const refund = json(h2.dms.find((d) => d.id === uid(2)).payload.embeds[0]);
  assert.equal(refund.title, '↩️ Market #1 was cancelled');
  assert.match(refund.description, /Question was ambiguous/);
  assert.match(refund.description, /Your stake of 120 pts was refunded/);
});

/* ---------------------------------------------------------------------------
 * More than two outcomes
 * ------------------------------------------------------------------------- */

const allButtons = (payload) => (payload.components ?? []).flatMap((r) => json(r).components);
function assertLayout(payload) {
  const rows = (payload.components ?? []).map(json);
  assert.ok(rows.length <= 5, `${rows.length} rows`);
  for (const r of rows) assert.ok(r.components.length >= 1 && r.components.length <= 5);
  const customIds = allButtons(payload).map((b) => b.custom_id).filter(Boolean);
  assert.equal(new Set(customIds).size, customIds.length, 'custom ids are unique');
}

test('the creation form takes one outcome per line', async () => {
  const { parseOutcomeLines } = require('../src/handlers/interactionHandler');
  assert.deepEqual(parseOutcomeLines('Home\r\n\n Draw \nAway\n'), ['Home', 'Draw', 'Away']);
  const h = harness();
  const ok = await h.run({
    kind: 'modal', user: uid(1), customId: ids.createModal(),
    fields: { question: 'Who wins the derby?', outcomes: 'Home\nDraw\n\nAway', duration: '1d' },
  });
  assert.match(ok.text(), /Market #1 created/);
  assert.deepEqual(h.services.markets.getMarket(1).outcomes.map((o) => o.label), ['Home', 'Draw', 'Away']);
  const tooMany = await h.run({
    kind: 'modal', user: uid(1), customId: ids.createModal(),
    fields: { question: 'Too many choices?', outcomes: Array.from({ length: 11 }, (_, i) => `O${i}`).join('\n'), duration: '1d' },
  });
  assert.match(tooMany.text(), /between 2 and 10 outcomes/);
  const one = await h.run({
    kind: 'modal', user: uid(1), customId: ids.createModal(),
    fields: { question: 'Only one choice?', outcomes: 'Lonely', duration: '1d' },
  });
  assert.match(one.text(), /between 2 and 10 outcomes/);
});

test('/market create with outcome_c.. options; prefilled form when incomplete', async () => {
  const h = harness();
  const i = await h.run(createCmd({ outcome_a: 'Home', outcome_b: 'Draw', outcome_c: 'Away' }));
  assert.match(i.text(), /Market #1 created/);
  assert.deepEqual(h.services.markets.getMarket(1).outcomes.map((o) => o.label), ['Home', 'Draw', 'Away']);
  // 3 bet buttons + My position share one row.
  const payload = h.sent[ANNOUNCE][0].payload;
  assert.equal(payload.components.length, 1);
  assert.deepEqual(allButtons(payload).map((b) => b.label), ['Bet: Home', 'Bet: Draw', 'Bet: Away', 'My position', 'Bets']);

  // Only outcome_a given: the form opens prefilled.
  const partial = await h.run({ kind: 'command', commandName: 'market', sub: 'create', user: uid(1), options: { question: 'Prefill?', outcome_a: 'Yes' } });
  assert.equal(partial.last()[0], 'showModal');
  const outcomesInput = partial.last()[1].components[1].component;
  assert.equal(outcomesInput.custom_id, 'outcomes');
  assert.equal(outcomesInput.value, 'Yes');
});

test('a 10-outcome market fits Discord limits in every state and resolves via button', async () => {
  const h = harness();
  const options = { question: 'Which of ten wins?' };
  'abcdefghij'.split('').forEach((l, i) => (options[`outcome_${l}`] = `Option ${i + 1}`));
  await h.run(createCmd(options));
  const opened = h.sent[ANNOUNCE][0].payload;
  assertLayout(opened);
  assert.equal(allButtons(opened).filter((b) => b.custom_id.startsWith('pm:bet:')).length, 10);
  const embed = json(opened.embeds[0]);
  assert.ok(embed.fields.length <= 25);
  assert.equal(embed.fields.filter((f) => /Option \d+/.test(f.name)).length, 10);

  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'Option 7', amount: 100 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(3), options: { market_id: 1, outcome: 'Option 9', amount: 300 } });
  const view = await h.run({ kind: 'command', commandName: 'market', sub: 'view', user: uid(2), options: { market_id: 1 } });
  assertLayout(view.last()[1]);
  assert.ok(allButtons(view.last()[1]).some((b) => b.label === 'Open announcement'));

  h.advance(HOUR);
  h.services.markets.closeExpiredMarkets();
  await h.publisher.syncAll();
  const closed = lastMarketEdit(h);
  assertLayout(closed);
  assert.equal(closed.components.length, 5, '2 bet rows + utility row + 2 resolve rows');
  assert.equal(resolveButtons(closed).length, 10);

  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 6) });
  assert.match(click.text(), /Winning outcome: \*\*Option 7\*\*/);
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });
  assert.equal(balance(h.services, uid(2)), 900 + 400);
  const resolved = lastMarketEdit(h);
  assertLayout(resolved);
  assert.match(embedText(resolved), /Option 7 — winner/);
  assertLedgerConsistent(assert, h.db);
});

/* ---------------------------------------------------------------------------
 * "Bets" view: who bet how much on what
 * ------------------------------------------------------------------------- */

test('the Bets button shows a private, filterable, paginated list of who bet what', async () => {
  const h = harness();
  await h.run(createCmd({ outcome_a: 'Home', outcome_b: 'Draw', outcome_c: 'Away' }));
  // 14 bettors on Home (stake grows with n), uid(30) bets on two outcomes.
  for (let n = 10; n < 24; n++) {
    await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(n), options: { market_id: 1, outcome: 'Home', amount: 10 * n } });
  }
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(30), options: { market_id: 1, outcome: 'Draw', amount: 500 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(30), options: { market_id: 1, outcome: 'Away', amount: 50 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(30), options: { market_id: 1, outcome: 'Draw', amount: 100 } });

  const button = allButtons(lastMarketEdit(h)).find((b) => b.custom_id === ids.bets(1));
  assert.equal(button.label, 'Bets (15)');

  // Opening it replies privately; the shared market message is not touched.
  const editsBefore = h.edits.length;
  const open = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(30), customId: ids.bets(1) });
  assert.equal(open.last()[0], 'reply');
  assert.ok(open.last()[1].flags, 'ephemeral');
  const text = json(open.last()[1].embeds[0]).description;
  assert.match(text, /🔵 \*\*Home\*\* — 2,310 pts · 14 bettors · 78\.0%/);
  assert.match(text, /🟠 \*\*Draw\*\* — 600 pts · 1 bettor/);
  assert.match(text, /Total: \*\*2,960 pts\*\* from 15 bettors/);
  assert.match(text, /\*\*Your bets:\*\* 🟠 600 · 🟢 50 \(650 pts\)/);
  // Biggest total first: uid(30) with 650, then uid(23) with 230 ...
  const lines = text.split('**All bettors** (15)\n')[1].split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[0], `\` 1.\` <@${uid(30)}> **650 pts** — 🟠 600 · 🟢 50`);
  assert.equal(lines[1], `\` 2.\` <@${uid(23)}> **230 pts** — 🔵 230`);
  assert.match(json(open.last()[1].embeds[0]).footer.text, /Page 1\/2/);

  // Page 2.
  const next = open.components().find((b) => b.label === 'Next ▶');
  assert.equal(next.custom_id, ids.betsPage(1, 'a', 2));
  const p2 = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(30), customId: next.custom_id });
  assert.equal(p2.last()[0], 'update');
  assert.equal(json(p2.last()[1].embeds[0]).description.split('(15)\n')[1].split('\n').length, 5);

  // Filter to one outcome with the select menu.
  const select = json(open.last()[1].components[0]).components[0];
  assert.equal(select.custom_id, ids.betsFilter(1));
  assert.deepEqual(select.options.map((o) => o.label), ['All outcomes', 'Home', 'Draw', 'Away']);
  const draw = await h.run({ kind: 'select', channelId: ANNOUNCE, user: uid(2), customId: ids.betsFilter(1), values: ['1'] });
  assert.equal(draw.last()[0], 'update');
  const drawText = json(draw.last()[1].embeds[0]).description;
  assert.match(drawText, /\*\*Bettors on Draw\*\* \(1\)\n` 1\.` <@\d+> \*\*600 pts\*\*$/);
  assert.match(drawText, /You have not bet on this market/);
  assert.equal(draw.last()[1].components.length, 1, 'no pager for a single page');
  const chosen = json(draw.last()[1].components[0]).components[0].options.find((o) => o.default);
  assert.equal(chosen.label, 'Draw');

  assert.equal(h.edits.length, editsBefore);

  // Tampered filter values are rejected.
  const bad = await h.run({ kind: 'select', channelId: ANNOUNCE, customId: ids.betsFilter(1), values: ["1' OR 1=1"] });
  assert.match(bad.text(), /Unknown filter/);
});

test('the Bets view works with no bets and is also in /market view', async () => {
  const h = harness();
  await h.run(createCmd());
  assert.equal(allButtons(h.sent[ANNOUNCE][0].payload).find((b) => b.custom_id === ids.bets(1)).label, 'Bets');
  const open = await h.run({ kind: 'button', channelId: ANNOUNCE, customId: ids.bets(1) });
  assert.match(open.text(), /No bets yet/);
  const view = await h.run({ kind: 'command', commandName: 'market', sub: 'view', options: { market_id: 1 } });
  assert.ok(view.components().some((b) => b.custom_id === ids.bets(1)));
});

test('the Bets view stays within Discord limits in the worst case', () => {
  const views = require('../src/discord/views');
  const outcomes = Array.from({ length: 10 }, (_, i) => ({ idx: i, label: `${i}`.repeat(50), pool: 999_999_999_999, bettors: 400, probability: 10, multiplier: 10 }));
  const market = { id: 1, question: 'Q'.repeat(200), outcomes, totalPool: 9_999_999_999_990, participants: 400 };
  const bettors = Array.from({ length: 400 }, (_, i) => ({ userId: uid(i + 1), stakes: Array(10).fill(99_999_999_999), total: 999_999_999_990, bets: 10, firstBet: i }));
  const view = views.betsView(market, bettors, { viewerId: uid(1), page: 7 });
  const embed = view.embeds[0].toJSON();
  assert.ok(embed.description.length <= 4096, `${embed.description.length} chars`);
  assert.ok(embed.description.length < 4096, 'fits without relying on the hard cap');
  const select = view.components[0].toJSON().components[0];
  assert.equal(select.options.length, 11);
  for (const o of select.options) assert.ok(o.label.length <= 100 && (o.description ?? '').length <= 100);
  assert.match(embed.footer.text, /Page 7\/40/);
});

/* ---------------------------------------------------------------------------
 * Result announcement lists losers too; old messages refresh after updates
 * ------------------------------------------------------------------------- */

test('results appear on the market message itself (winners and losers), with no reply post', async () => {
  const h = harness();
  await h.run(createCmd({ outcome_a: 'C', outcome_b: 'D' }));
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(2), options: { market_id: 1, outcome: 'D', amount: 50 } });
  await h.run({ kind: 'command', commandName: 'market', sub: 'bet', user: uid(3), options: { market_id: 1, outcome: 'C', amount: 50 } });
  h.advance(HOUR);
  const click = await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: ids.resolve(1, 1) });
  await h.run({ kind: 'button', channelId: ANNOUNCE, user: uid(1), customId: click.components()[0].custom_id });

  assert.equal(h.sent[ANNOUNCE].length, 1, 'nothing posted besides the market message');
  assert.equal(h.sent[BETTING].length, 0);
  const payload = lastMarketEdit(h);
  const embed = json(payload.embeds[0]);
  assert.match(embed.description, /Resolved:\*\* D/);
  assert.equal(embed.fields.find((f) => f.name === 'Payouts').value, '1 winner shared **100 pts**; 1 bettor lost.');
  const results = embed.fields.find((f) => f.name.startsWith('Results'));
  assert.equal(results.name, 'Results · 1 won, 1 lost');
  assert.deepEqual(results.value.split('\n'), [
    `✅ <@${uid(2)}> won **+50 pts** (staked 50 pts, paid 100 pts)`,
    `❌ <@${uid(3)}> lost **50 pts**`,
  ]);
  assert.ok(allButtons(payload).some((b) => b.custom_id === ids.bets(1)), 'Bets button stays on the resolved market');
  // Bettors still get their DMs.
  assert.deepEqual(h.dms.filter((d) => /You (won|lost)/.test(JSON.stringify(json(d.payload.embeds[0])))).map((d) => d.id).sort(), [uid(2), uid(3)]);
});

test('refund and no-bet resolutions are summarised on the market message', async () => {
  const views = require('../src/discord/views');
  const base = {
    id: 1, question: 'Q?', description: null, status: 'RESOLVED', creator_id: uid(1), created_at: 0, expires_at: 1,
    resolved_at: 2, resolver_id: uid(1), resolved_by_admin: 0, winning_outcome: 0, totalPool: 100, participants: 1,
    outcomes: [{ idx: 0, label: 'A', pool: 0, bettors: 0, probability: 0, multiplier: null }, { idx: 1, label: 'B', pool: 100, bettors: 1, probability: 100, multiplier: 1 }],
  };
  const payoutsField = (settlement) => views.marketEmbed(base, { now: 3, settlement }).toJSON().fields.find((f) => f.name === 'Payouts').value;
  assert.equal(
    payoutsField({ total_pool: 100, total_paid: 100, winner_count: 0, refunded: 1, payouts: [{ user_id: uid(2), staked: 100, paid: 100 }] }),
    'Nobody bet on **A**, so all 100 pts were refunded.',
  );
  assert.equal(payoutsField({ total_pool: 0, total_paid: 0, winner_count: 0, refunded: 0, payouts: [] }), 'No bets were placed, so no points changed hands.');
});

test('result posts queued by an older version are retired without posting', async () => {
  const h = harness();
  await h.run(createCmd());
  h.services.outbox.enqueue('resolved:1', 'MARKET_RESOLVED', 1);
  h.services.outbox.enqueue('cancelled:1', 'MARKET_CANCELLED', 1);
  await h.notifier.dispatch();
  assert.equal(h.sent[ANNOUNCE].length, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) FROM notifications WHERE status <> 'SENT'").pluck().get(), 0);
});

test('after a layout change, published market messages are refreshed once on startup', async () => {
  const { LAYOUT_VERSION } = require('../src/discord/views');
  const h = harness();
  await h.run(createCmd());
  await h.run(createCmd({ question: 'Second market here?' }));
  h.services.markets.createMarket({ creatorId: uid(1), question: 'Never published?', outcomes: ['A', 'B'], duration: '1h', creationKey: 'np' });
  assert.deepEqual(h.services.markets.marketsNeedingSync(), [3], 'only the unpublished one is pending');

  // First start with this layout version: both published messages are re-rendered.
  assert.equal(h.services.markets.refreshLayout(LAYOUT_VERSION), 2);
  const before = h.edits.length;
  await h.publisher.syncAll();
  assert.equal(h.edits.length, before + 2);
  assert.ok(allButtons(h.edits.at(-1).payload).some((b) => b.custom_id.startsWith('pm:bt:')), 'new Bets button present');

  // Later restarts with the same version do nothing.
  assert.equal(h.services.markets.refreshLayout(LAYOUT_VERSION), 0);
  // A future layout bump refreshes again.
  assert.equal(h.services.markets.refreshLayout(LAYOUT_VERSION + 1), 3);
});
