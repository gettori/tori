// The persisted-usage wire types, mirroring `chat/usage.rs`.
//
// Separate from `chatUsage.ts`, which is the *arithmetic* over a live session's
// frames. This is the durable tally the ceiling is measured against: one is
// what the panel is showing, the other is what survives the panel closing.

/** One session's running total, as `chat/usage.rs` records it. */
export type SessionUsage = {
  tokens: number;
  /** Null until some turn reported a cost, so a agent that reports no money
   *  reads as unknown rather than as free. */
  costUsd: number | null;
  /** Turns Tori watched finish, which the two figures above are the sum of. */
  turns: number;
};

/** Both sums a ceiling can be measured against, returned together so a caller
 *  never needs a second round trip for the one it did not ask for. */
export type UsageTotals = {
  session: SessionUsage;
  project: SessionUsage;
};
