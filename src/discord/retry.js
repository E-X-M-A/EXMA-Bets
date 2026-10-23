'use strict';

const logger = require('../utils/logger');

// Discord API error codes that will never succeed on retry.
const PERMANENT_CODES = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10007, // Unknown Member
  10008, // Unknown Message
  10013, // Unknown User
  10062, // Unknown Interaction
  40060, // Interaction already acknowledged
  50001, // Missing Access
  50007, // Cannot send messages to this user
  50013, // Missing Permissions
  50035, // Invalid Form Body
]);

const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function isTransient(err) {
  if (!err) return false;
  if (PERMANENT_CODES.has(err.code)) return false;
  if (typeof err.status === 'number') return err.status >= 500 || err.status === 429;
  if (err.name === 'AbortError' || err.name === 'RateLimitError') return true;
  return TRANSIENT_NET_CODES.has(err.code) || TRANSIENT_NET_CODES.has(err.cause?.code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` on transient Discord/network failures with exponential backoff.
 * Rate limits (429) are normally queued by discord.js itself; this covers 5xx,
 * timeouts and dropped connections. Never wrap non-idempotent DB work in here.
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 1000, label = 'discord call' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(`${label} failed (${err.status ?? err.code ?? err.name}); retry ${attempt + 1}/${retries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isTransient, PERMANENT_CODES };
