'use strict';

const market = require('./market');
const admin = require('./admin');
const { balance, leaderboard, profile, help } = require('./user');

/** All slash commands, keyed by name. `scope` drives channel/permission checks. */
const commands = new Map([market, admin, balance, leaderboard, profile, help].map((c) => [c.data.name, c]));

module.exports = { commands };
