import { limitTypeChip, quotaState, type QuotaState } from "./chatRateLimit";
import type { WindowReading } from "./usageStore";

/** The window with the least headroom: what a one-bar row has to show, since
 *  the reason to glance at the strip is the limit you are nearest to. */
export function tightestWindow(windows: WindowReading[], warnAt: number, now = Date.now()): WindowReading | null {
  const rank: Record<QuotaState, number> = { reached: 3, approaching: 2, ok: 1, expired: 0 };
  let best: WindowReading | null = null;
  let bestScore = -1;
  for (const w of windows) {
    const score = rank[quotaState(w, warnAt, now)] * 2 + (w.utilization ?? 0);
    if (score > bestScore) {
      best = w;
      bestScore = score;
    }
  }
  return best;
}

function untilText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** An account as one line: each window's level, when the fullest one resets,
 *  and that one as a meter, warning past the account's Warn at. A window past
 *  its reset reads 0%, as the strip draws it. */
export function usageSummary(
  account: { windows: WindowReading[]; warnAt: number },
  now: number,
): { sub: string; level: number; warn: boolean } {
  const levels = account.windows.map((w) => {
    const pct =
      quotaState(w, account.warnAt, now) === "expired"
        ? "0%"
        : w.utilization === null
          ? "?"
          : `${Math.round(w.utilization * 100)}%`;
    return `${limitTypeChip(w.kind)} ${pct}`;
  });
  const tight = tightestWindow(account.windows, account.warnAt, now);
  const state = tight ? quotaState(tight, account.warnAt, now) : "expired";
  const resetAt = tight?.resetsAt != null ? tight.resetsAt * 1000 : null;
  const resets =
    state !== "expired" && resetAt !== null && resetAt > now ? [`resets in ${untilText(resetAt - now)}`] : [];
  return {
    sub: [...levels, ...resets].join(", "),
    level: state === "expired" ? 0 : Math.min(1, tight?.utilization ?? 0),
    warn: state === "approaching" || state === "reached",
  };
}
