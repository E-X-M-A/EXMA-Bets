'use strict';

/**
 * Pure pari-mutuel arithmetic. All amounts are integer points.
 *
 * Winners get their stake back plus a share of the losing pool proportional to
 * their stake: payout = stake + stake * losingPool / winningPool. Shares are
 * floored, then the leftover points (always fewer than the number of winning bets)
 * go one each to the bets with the largest fractional remainder (ties: oldest bet
 * first). The sum of payouts therefore always equals the total pool exactly.
 */
function computeSettlement(bets, winningOutcome, outcomeCount) {
  const pools = Array.from({ length: outcomeCount }, () => 0);
  for (const bet of bets) pools[bet.outcome] += bet.stake;
  const totalPool = pools.reduce((a, b) => a + b, 0);

  if (bets.length === 0) {
    return { mode: 'NO_BETS', pools, totalPool, results: [] };
  }

  const winningPool = pools[winningOutcome];
  if (winningPool === 0) {
    // Nobody backed the winner: everybody gets their stake back.
    return {
      mode: 'REFUND',
      pools,
      totalPool,
      results: bets.map((b) => ({ betId: b.id, userId: b.userId, stake: b.stake, status: 'REFUNDED', payout: b.stake })),
    };
  }

  const losingPool = totalPool - winningPool;
  const W = BigInt(winningPool);
  const L = BigInt(losingPool);
  const winners = [];
  const results = [];
  let distributed = 0;

  for (const bet of bets) {
    if (bet.outcome !== winningOutcome) {
      results.push({ betId: bet.id, userId: bet.userId, stake: bet.stake, status: 'LOST', payout: 0 });
      continue;
    }
    const numerator = BigInt(bet.stake) * L;
    const share = Number(numerator / W);
    const result = { betId: bet.id, userId: bet.userId, stake: bet.stake, status: 'WON', payout: bet.stake + share };
    winners.push({ result, remainder: numerator % W, id: bet.id });
    results.push(result);
    distributed += share;
  }

  let leftover = losingPool - distributed;
  winners.sort((a, b) => (a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1));
  for (let i = 0; leftover > 0; i++, leftover--) winners[i].result.payout += 1;

  return { mode: 'PAYOUT', pools, totalPool, results };
}

/**
 * Display statistics for a market: implied probabilities (share of stakes, one
 * decimal) and estimated payout multipliers if the market closed right now.
 */
function marketStats(pools) {
  const total = pools.reduce((a, b) => a + b, 0);
  return pools.map((pool) => ({
    pool,
    probability: total > 0 ? Math.round((pool / total) * 1000) / 10 : Math.round(1000 / pools.length) / 10,
    // Points returned per point staked if this outcome wins (rounded down to 2 decimals).
    multiplier: pool > 0 ? Math.floor((total / pool) * 100) / 100 : null,
  }));
}

/** Estimated payout for a hypothetical new stake on `outcome` given current pools. */
function estimatePayout(pools, outcome, stake) {
  const after = pools.map((p, i) => (i === outcome ? p + stake : p));
  const total = after.reduce((a, b) => a + b, 0);
  return Number((BigInt(stake) * BigInt(total)) / BigInt(after[outcome]));
}

module.exports = { computeSettlement, marketStats, estimatePayout };
