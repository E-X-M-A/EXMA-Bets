'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uid, balance, assertLedgerConsistent } = require('./helpers');
const { UserError } = require('../src/utils/errors');

test('new users receive the initial balance exactly once', () => {
  const { services, db } = setup();
  const first = services.users.ensureUser(uid(1), 'alice');
  assert.equal(first.created, true);
  assert.equal(first.balance, 1000);
  const again = services.users.ensureUser(uid(1), 'alice-renamed');
  assert.equal(again.created, false);
  assert.equal(again.balance, 1000);
  assert.equal(again.username, 'alice-renamed', 'username changes do not create a new account');
  assert.equal(db.prepare("SELECT COUNT(*) FROM transactions WHERE type = 'INITIAL_BALANCE'").pluck().get(), 1);
  assertLedgerConsistent(assert, db);
});

test('accounts are keyed by Discord ID and reject malformed IDs', () => {
  const { services } = setup();
  assert.throws(() => services.users.ensureUser('not-an-id'), UserError);
  assert.throws(() => services.users.ensureUser('123'), UserError);
});

test('ledger entries are idempotent and balances never go negative', () => {
  const { services, db } = setup();
  services.users.ensureUser(uid(1));
  const a = services.users.applyTransaction(uid(1), 50, { type: 'ADMIN_GRANT', key: 'grant-1' });
  const b = services.users.applyTransaction(uid(1), 50, { type: 'ADMIN_GRANT', key: 'grant-1' });
  assert.equal(a.applied, true);
  assert.equal(b.applied, false);
  assert.equal(balance(services, uid(1)), 1050);

  assert.throws(
    () => services.users.applyTransaction(uid(1), -1051, { type: 'ADMIN_REMOVE', key: 'remove-1' }),
    (err) => err instanceof UserError && err.code === 'INSUFFICIENT_BALANCE',
  );
  assert.equal(balance(services, uid(1)), 1050);
  services.users.applyTransaction(uid(1), -1050, { type: 'ADMIN_REMOVE', key: 'remove-2' });
  assert.equal(balance(services, uid(1)), 0);
  assertLedgerConsistent(assert, db);
});

test('non-integer amounts are rejected', () => {
  const { services } = setup();
  services.users.ensureUser(uid(1));
  assert.throws(() => services.users.applyTransaction(uid(1), 1.5, { type: 'ADMIN_GRANT', key: 'x' }));
  assert.throws(() => services.users.applyTransaction(uid(1), 0, { type: 'ADMIN_GRANT', key: 'y' }));
});

test('the database rejects negative balances even if application code is bypassed', () => {
  const { services, db } = setup();
  services.users.ensureUser(uid(1));
  assert.throws(() => db.prepare('UPDATE users SET balance = -1 WHERE id = ?').run(uid(1)), /CHECK constraint/);
});
