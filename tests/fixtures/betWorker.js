'use strict';

// Worker used by the concurrency test: opens its own connection to the shared test
// database file and hammers the same market/user with bets.
const { parentPort, workerData } = require('node:worker_threads');
const { openDatabase } = require('../../src/database');
const { createServices } = require('../../src/services');
const { baseConfig } = require('../helpers');

const { file, marketId, userId, attempts, stake, worker } = workerData;
const db = openDatabase(file);
const services = createServices(db, baseConfig);

let placed = 0;
let rejected = 0;
const unexpected = [];
for (let i = 0; i < attempts; i++) {
  try {
    services.betting.placeBet({ marketId, userId, outcome: i % 2, stake, idempotencyKey: `w${worker}-${i}` });
    placed++;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') rejected++;
    else unexpected.push(`${err.code}: ${err.message}`);
  }
}
db.close();
parentPort.postMessage({ placed, rejected, unexpected });
