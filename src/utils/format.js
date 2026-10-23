'use strict';

const { escapeMarkdown } = require('discord.js');

function points(n) {
  return `${Number(n).toLocaleString('en-US')} pts`;
}

function signedPoints(n) {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US')} pts`;
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Plain-text safe name for embeds (no markdown injection, no mentions). */
function safeName(name) {
  return escapeMarkdown(truncate(String(name ?? 'Unknown user').replace(/@/g, '@​'), 32));
}

function progressBar(fraction, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

module.exports = { points, signedPoints, truncate, safeName, progressBar, escapeMarkdown };
