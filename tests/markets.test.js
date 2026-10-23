'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uid, createMarket, bet, HOUR } = require('./helpers');
const { UserError } = require('../src/utils/errors');

const create = (services, overrides = {}) =>
  services.markets.createMarket({
    creatorId: uid(1),
    question: 'Will Bitcoin exceed $120,000 by December 31?',
    outcomes: ['YES', 'NO'],
    duration: '7d',
    creationKey: `key-${Math.random()}`,
    ...overrides,
  });

test('creates a market with exact UTC expiry, creator and outcomes', () => {
  const { services, clock } = setup();
  const { market } = create(services, { description: 'Resolves using CoinGecko close price.' });
  assert.equal(market.status, 'OPEN');
  assert.equal(market.creator_id, uid(1));
  assert.equal(market.created_at, clock.now);
  assert.equal(market.expires_at, clock.now + 7 * 24 * HOUR);
  assert.deepEqual(market.outcomes.map((o) => o.label), ['YES', 'NO']);
  assert.equal(market.description, 'Resolves using CoinGecko close price.');
  assert.equal(market.totalPool, 0);
  assert.equal(services.users.getUser(uid(1)).balance, 1000, 'creator account was created');
});

test('validates question, outcomes, description and duration', () => {
  const { services } = setup();
  const bad = (overrides) => assert.throws(() => create(services, overrides), UserError);
  bad({ question: 'Hi?' });
  bad({ question: 'x'.repeat(201) });
  bad({ outcomes: ['YES'] });
  bad({ outcomes: ['YES', 'NO', 'MAYBE'] });
  bad({ outcomes: ['YES', 'yes'] });
  bad({ outcomes: ['YES', ''] });
  bad({ outcomes: ['YES', 'x'.repeat(51)] });
  bad({ description: 'x'.repeat(1001) });
  bad({ duration: '10s' });
  bad({ duration: '2m' }); // below 5 minutes
  bad({ duration: '91d' });
  bad({ duration: 'tomorrow' });
  for (const duration of ['30m', '6h', '2d', '7d', '1w', '1d12h']) create(services, { duration, question: `Question for ${duration}?` });
});

test('neutralises mass mentions in user text', () => {
  const { services } = setup();
  const { market } = create(services, { question: 'Will @everyone show up?' });
  assert.ok(!market.question.includes('@everyone'));
});

test('replaying the same creation interaction does not create a duplicate', () => {
  const { services, db } = setup();
  const a = create(services, { creationKey: 'interaction-1' });
  const b = create(services, { creationKey: 'interaction-1' });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.market.id, b.market.id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM markets').pluck().get(), 1);
});

test('rapid duplicate submissions with the same question are rejected', () => {
  const { services, advance } = setup();
  create(services, { creationKey: 'a' });
  assert.throws(() => create(services, { creationKey: 'b' }), /Duplicate/);
  advance(3 * 60_000);
  create(services, { creationKey: 'c' }); // allowed again after the window
});

test('market ids are unique and sequential', () => {
  const { services } = setup();
  const ids = [1, 2, 3].map((n) => create(services, { question: `Question number ${n}?` }).market.id);
  assert.equal(new Set(ids).size, 3);
});

test('expiry closes markets once and queues exactly one creator notification', () => {
  const { services, db, advance } = setup();
  const m = createMarket(services, { duration: '1h' });
  assert.deepEqual(services.markets.closeExpiredMarkets(), []);
  advance(HOUR);
  assert.deepEqual(services.markets.closeExpiredMarkets(), [m.id]);
  assert.deepEqual(services.markets.closeExpiredMarkets(), []);
  const market = services.markets.getMarket(m.id);
  assert.equal(market.status, 'AWAITING_RESOLUTION');
  assert.ok(market.closed_at);
  assert.equal(market.winning_outcome, null, 'expiry does not resolve');
  assert.equal(db.prepare("SELECT COUNT(*) FROM notifications WHERE kind = 'MARKET_EXPIRED'").pluck().get(), 1);
  assert.ok(market.sync_version > market.synced_version, 'embed marked for refresh');
});

test('state changes flag the published embed for refresh', () => {
  const { services } = setup();
  const m = createMarket(services);
  services.markets.markSynced(m.id, services.markets.getMarket(m.id).sync_version);
  assert.deepEqual(services.markets.marketsNeedingSync(), []);
  bet(services, m.id, uid(2), 'YES', 10);
  assert.deepEqual(services.markets.marketsNeedingSync(), [m.id]);
});

test('listing and searching markets', () => {
  const { services } = setup();
  for (let i = 1; i <= 7; i++) create(services, { question: `Listed market ${i}?` });
  const page1 = services.markets.listMarkets('OPEN', 1, 5);
  const page2 = services.markets.listMarkets('OPEN', 2, 5);
  assert.equal(page1.total, 7);
  assert.equal(page1.pages, 2);
  assert.equal(page1.markets.length, 5);
  assert.equal(page2.markets.length, 2);
  assert.equal(services.markets.listMarkets('OPEN', 99, 5).page, 2, 'page is clamped');
  assert.equal(services.markets.searchMarkets('market 3', { statuses: ['OPEN'] }).length, 1);
  assert.equal(services.markets.searchMarkets('3', { statuses: ['OPEN'] })[0].id, 3);
  assert.equal(services.markets.searchMarkets('%', { statuses: ['OPEN'] }).length, 0, 'LIKE wildcards are escaped');
});
