'use strict';

/**
 * Component custom IDs. They are stateless (everything needed is encoded or looked
 * up in the database), so buttons keep working after a restart. The "pm" prefix
 * namespaces them; anything else is rejected as an unknown component.
 */
const PREFIX = 'pm';

const ids = {
  bet: (marketId, outcome) => `${PREFIX}:bet:${marketId}:${outcome}`,
  betModal: (marketId, outcome) => `${PREFIX}:betmodal:${marketId}:${outcome}`,
  position: (marketId) => `${PREFIX}:pos:${marketId}`,
  resolve: (marketId, outcome) => `${PREFIX}:res:${marketId}:${outcome}`,
  resolveModal: (marketId, outcome) => `${PREFIX}:resmodal:${marketId}:${outcome}`,
  results: (marketId) => `${PREFIX}:rs:${marketId}`,
  resultsPage: (marketId, page) => `${PREFIX}:rsp:${marketId}:${page}`,
  bets: (marketId) => `${PREFIX}:bt:${marketId}`,
  // filter: "a" = all outcomes, otherwise the outcome index
  betsPage: (marketId, filter, page) => `${PREFIX}:btp:${marketId}:${filter}:${page}`,
  betsFilter: (marketId) => `${PREFIX}:btf:${marketId}`,
  confirm: (confirmationId) => `${PREFIX}:cf:${confirmationId}`,
  abort: (confirmationId) => `${PREFIX}:cx:${confirmationId}`,
  createModal: () => `${PREFIX}:create`,
  leaderboard: (type, page, ownerId) => `${PREFIX}:lb:${type}:${page}:${ownerId}`,
  marketList: (status, page, ownerId) => `${PREFIX}:ml:${status}:${page}:${ownerId}`,
};

const PATTERNS = {
  bet: /^pm:bet:(\d{1,12}):(\d{1,2})$/,
  betModal: /^pm:betmodal:(\d{1,12}):(\d{1,2})$/,
  position: /^pm:pos:(\d{1,12})$/,
  resolve: /^pm:res:(\d{1,12}):(\d{1,2})$/,
  resolveModal: /^pm:resmodal:(\d{1,12}):(\d{1,2})$/,
  results: /^pm:rs:(\d{1,12})$/,
  resultsPage: /^pm:rsp:(\d{1,12}):(\d{1,6})$/,
  bets: /^pm:bt:(\d{1,12})$/,
  betsPage: /^pm:btp:(\d{1,12}):(a|\d{1,2}):(\d{1,6})$/,
  betsFilter: /^pm:btf:(\d{1,12})$/,
  confirm: /^pm:cf:([\w-]{8,32})$/,
  abort: /^pm:cx:([\w-]{8,32})$/,
  createModal: /^pm:create$/,
  leaderboard: /^pm:lb:(balance|wagered|profit|wins):(\d{1,6}):(\d{17,20})$/,
  marketList: /^pm:ml:(OPEN|AWAITING_RESOLUTION|RESOLVED|CANCELLED):(\d{1,6}):(\d{17,20})$/,
};

/** Returns `{ type, args }` for a known custom id, or null. */
function parseCustomId(customId) {
  if (typeof customId !== 'string' || customId.length > 100) return null;
  for (const [type, re] of Object.entries(PATTERNS)) {
    const m = re.exec(customId);
    if (m) return { type, args: m.slice(1) };
  }
  return null;
}

module.exports = { ids, parseCustomId };
