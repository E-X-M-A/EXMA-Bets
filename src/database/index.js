'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const migrations = require('./migrations');

/**
 * Opens (and migrates) the SQLite database.
 * better-sqlite3 is synchronous: every transaction runs to completion without
 * yielding to the event loop, so concurrent interactions in this process can never
 * interleave inside a transaction. `BEGIN IMMEDIATE` plus `busy_timeout` also
 * serialises writers across processes.
 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      record.run(m.version, m.name, Date.now());
    }).immediate();
  }
}

/** Runs `fn` in a `BEGIN IMMEDIATE` transaction (savepoint when nested). */
function tx(db, fn) {
  return db.transaction(fn).immediate();
}

module.exports = { openDatabase, migrate, tx };
