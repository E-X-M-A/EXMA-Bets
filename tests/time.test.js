'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/utils/time');
const logger = require('../src/utils/logger');

test('parseDuration', () => {
  assert.equal(t.parseDuration('30m'), 30 * t.MINUTE);
  assert.equal(t.parseDuration('6h'), 6 * t.HOUR);
  assert.equal(t.parseDuration('2d'), 2 * t.DAY);
  assert.equal(t.parseDuration('1w'), 7 * t.DAY);
  assert.equal(t.parseDuration('1d 12h'), 36 * t.HOUR);
  assert.equal(t.parseDuration('7D'), 7 * t.DAY);
  for (const bad of ['', '5', 'h', '0m', '-1h', '1.5h', '1y', 'abc', '9999999d']) assert.equal(t.parseDuration(bad), null, bad);
});

test('local dates and midnights in Europe/Berlin', () => {
  const tz = 'Europe/Berlin';
  assert.equal(t.localDate(Date.UTC(2026, 9, 23, 21, 59), tz), '2026-10-23');
  assert.equal(t.localDate(Date.UTC(2026, 9, 23, 22, 0), tz), '2026-10-24'); // CEST, UTC+2
  assert.equal(t.localDate(Date.UTC(2026, 11, 31, 23, 0), tz), '2027-01-01'); // CET, UTC+1
  assert.equal(t.startOfLocalDay('2026-07-01', tz), Date.UTC(2026, 5, 30, 22, 0));
  assert.equal(t.startOfLocalDay('2026-01-15', tz), Date.UTC(2026, 0, 14, 23, 0));
  // DST switch days
  assert.equal(t.startOfLocalDay('2026-03-29', tz), Date.UTC(2026, 2, 28, 23, 0));
  assert.equal(t.startOfLocalDay('2026-03-30', tz), Date.UTC(2026, 2, 29, 22, 0));
  assert.equal(t.startOfLocalDay('2026-10-25', tz), Date.UTC(2026, 9, 24, 22, 0));
  assert.equal(t.startOfLocalDay('2026-10-26', tz), Date.UTC(2026, 9, 25, 23, 0));
  assert.equal(t.msUntilNextLocalMidnight(Date.UTC(2026, 9, 23, 21, 0), tz), t.HOUR);
});

test('date helpers', () => {
  assert.equal(t.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(t.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(t.dateRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(t.discordTimestamp(1_700_000_000_999, 'R'), '<t:1700000000:R>');
  assert.equal(t.formatDuration(90 * t.MINUTE), '1h 30m');
});

test('the logger never prints secrets', () => {
  const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB';
  logger.addSecret('super-secret-value');
  assert.equal(logger.redact('token=super-secret-value'), 'token=[REDACTED]');
  assert.equal(logger.redact(`login with ${token}`), 'login with [REDACTED]');
});
