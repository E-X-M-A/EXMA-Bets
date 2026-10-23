'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
const secrets = new Set();

/** Registers a value (e.g. the bot token) that must never appear in log output. */
function addSecret(value) {
  if (value && value.length >= 8) secrets.add(value);
}

function setLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function redact(text) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  // Belt and braces: anything shaped like a bot token.
  return out.replace(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g, '[REDACTED]');
}

function format(arg) {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function log(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(args.map(format).join(' '))}`;
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

module.exports = {
  addSecret,
  setLevel,
  redact,
  debug: (...a) => log('debug', a),
  info: (...a) => log('info', a),
  warn: (...a) => log('warn', a),
  error: (...a) => log('error', a),
};
