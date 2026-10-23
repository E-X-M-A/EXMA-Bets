'use strict';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MIN_DURATION_MS = 5 * MINUTE;
const MAX_DURATION_MS = 90 * DAY;

const UNIT_MS = { m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/**
 * Parses durations like "30m", "6h", "2d", "1w" or combinations such as "1d12h".
 * Returns milliseconds, or null when the input is not a valid duration.
 */
function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text || !/^(\d+[mhdw])+$/.test(text)) return null;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([mhdw])/g)) {
    if (amount.length > 6) return null;
    total += Number(amount) * UNIT_MS[unit];
  }
  return total > 0 ? total : null;
}

function formatDuration(ms) {
  if (ms <= 0) return '0m';
  const parts = [];
  let rest = Math.ceil(ms / MINUTE) * MINUTE;
  for (const [unit, size] of [['d', DAY], ['h', HOUR], ['m', MINUTE]]) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(' ');
}

const dateFormatters = new Map();
function partsFormatter(timeZone) {
  if (!dateFormatters.has(timeZone)) {
    dateFormatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  return dateFormatters.get(timeZone);
}

function zonedParts(ms, timeZone) {
  const out = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** The local calendar date ("YYYY-MM-DD") in `timeZone` at instant `ms`. */
function localDate(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (Berlin summer: +2h). */
function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of 00:00 local time on `date` ("YYYY-MM-DD") in `timeZone`. DST-aware. */
function startOfLocalDay(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  // Re-evaluate once in case the offset differs at the corrected instant (DST edge).
  instant = guess - zoneOffsetMs(instant, timeZone);
  return instant;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Inclusive list of dates between two "YYYY-MM-DD" strings. */
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Milliseconds from `now` until the next local midnight in `timeZone`. */
function msUntilNextLocalMidnight(now, timeZone) {
  return startOfLocalDay(addDays(localDate(now, timeZone), 1), timeZone) - now;
}

/** Discord timestamp markup, e.g. <t:1700000000:R>. */
function discordTimestamp(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** The creation time encoded in a Discord snowflake. */
function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
  parseDuration,
  formatDuration,
  localDate,
  zoneOffsetMs,
  startOfLocalDay,
  addDays,
  dateRange,
  msUntilNextLocalMidnight,
  discordTimestamp,
  snowflakeTime,
};
