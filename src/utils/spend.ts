// How a rolled up spend reads on a row or a card. An agent that reports no
// money (ACP) still counts turns, and "12 turns" is the honest figure for it;
// "$0.00" would read as free.
import type { SessionUsage } from "./chatUsageStore";

export type SpendView = { text: string; says: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function spendView(usage: SessionUsage | null | undefined, what: string): SpendView | null {
  if (!usage) return null;
  if (usage.costUsd !== null) {
    const dollars = `$${usage.costUsd.toFixed(2)}`;
    return { text: dollars, says: `${dollars} spent on ${what} across ${plural(usage.turns, "turn")}` };
  }
  if (usage.turns === 0) return null;
  return {
    text: plural(usage.turns, "turn"),
    says: `${plural(usage.turns, "turn")} on ${what}, no cost reported: this agent reports context, not dollars`,
  };
}
