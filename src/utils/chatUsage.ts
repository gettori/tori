// Turning a turn's `result` record into the two numbers a user actually asks
// for: what that turn cost, and what the session has cost so far.
//
// Split out of the component so the arithmetic and the wording are unit-tested
// against the same figures the wire carries, and so the one non-obvious fact
// about this data has a single place to be written down:
//
//   **`total_cost_usd` is per turn, despite the name.** Measured on the
//   two-turn capture (`dev/fixtures/claude/two-turns.jsonl`): both result
//   frames report `num_turns: 1` and identical `input_tokens: 2` /
//   `output_tokens: 3`, which a session-cumulative figure could not do. So a
//   session total is the sum of the turns Sway saw, and the newest frame is
//   only ever the newest *turn*.
//
// The consequence of that measurement is the honesty rule below: Sway can only
// total the turns it observed. A chat opened on a session with prior turns has
// history it never had a `result` frame for, so its session total is a floor,
// not the truth, and it says so rather than presenting a partial sum as final.
import type { Usage } from "./chatTypes";

/** Billable tokens for one turn: what was sent plus what came back. Cache reads
 *  are counted because they are billed, at a lower rate the cost figure already
 *  reflects - dropping them would make the token count disagree with the money
 *  beside it. */
export function turnTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Compact token count, matching the rounding the transcript notices and the
 *  context meter use so one session never reports two figures for one number. */
export function fmtTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * Money, at the precision the figure actually has.
 *
 * Sub-cent turns are the common case here (the captures run to four decimal
 * places), and rounding those to `$0.01` would make every turn look identical
 * and the session total look wrong next to them. Anything at or above a cent
 * gets the two decimals people read prices in.
 */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export type UsageSummary = {
  /** The last completed turn, or null before one finishes. */
  turn: { tokens: number; cost: number | null } | null;
  /** Every turn this chat watched complete. */
  session: { tokens: number; cost: number | null; turns: number };
};

export function usageSummary(s: {
  /** The last **completed** turn's usage, not the live `lastUsage` the context
   *  meter reads: that one moves mid-turn while the cost beside it cannot. */
  lastTurnUsage: Usage | null;
  lastCostUsd: number | null;
  totalUsage: Usage;
  totalCostUsd: number | null;
  turnsCompleted: number;
}): UsageSummary {
  return {
    turn: s.lastTurnUsage === null ? null : { tokens: turnTokens(s.lastTurnUsage), cost: s.lastCostUsd },
    session: {
      tokens: turnTokens(s.totalUsage),
      cost: s.totalCostUsd,
      turns: s.turnsCompleted,
    },
  };
}
