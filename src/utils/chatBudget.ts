// When a chat has spent enough to be stopped, and what it is told when it is.
//
// Pure, so the one thing that matters here - that a ceiling stops a session
// exactly once, at a boundary, with a reason the model will not try to argue
// with - is testable without a running agent.
//
// **The stop is a terminal denial and nothing else.** Phase 2's budget spike put
// three trials through a `PreToolUse` denial that offered no way forward: all
// three stopped on the first refusal (four tool calls each), with no retry, no
// `Bash` workaround, no attempt at an alternative approach, and a closing report
// of what was left undone. The plan had hedged between a tool-boundary stop and
// a turn-boundary fallback depending on that result, and had budgeted for an
// immediate interrupt alongside the denial. The denial alone was enough, so the
// interrupt was never built - it would have been an untested path guarding
// against a behaviour that was measured not to happen.
//
// That measurement is an observation at n=3 against one CLI version, not a
// contract. It is written down here rather than in a commit message so that if a
// later version starts working around the refusal, the thing to re-check is
// obvious.
import type { Budgets } from "../panels/Settings/settingsStore";

export type Spend = {
  /** This session's cumulative cost, or null when nothing reported one. */
  sessionUsd: number | null;
  /** Every session in this project, summed. */
  projectUsd: number | null;
  /** The live turn's context window as a percentage, or null before a turn. */
  contextPercent: number | null;
};

/** Which ceiling was crossed. Named rather than boolean, because the message
 *  has to say *which* budget stopped the session for it to be actionable. */
export type BudgetBreach = {
  kind: "session" | "project" | "context";
  /** What has been spent, in that ceiling's own units. */
  spent: number;
  limit: number;
};

/**
 * The first ceiling this spend has crossed, or null.
 *
 * Order is deliberate: session before project before context. A session that
 * blew its own budget should say so rather than blaming the project it happens
 * to sit in, and context is checked last because it is the one that recovers on
 * its own after a compaction.
 *
 * An unset ceiling is not a zero. Every comparison is guarded on the limit being
 * a number, so "unlimited" cannot collapse into "stop immediately" - the failure
 * mode that would make this feature actively hostile.
 */
export function breach(spend: Spend, budgets: Budgets): BudgetBreach | null {
  const checks: [BudgetBreach["kind"], number | null, number | null][] = [
    ["session", spend.sessionUsd, budgets.sessionUsd],
    ["project", spend.projectUsd, budgets.projectUsd],
    ["context", spend.contextPercent, budgets.contextPercent],
  ];
  for (const [kind, spent, limit] of checks) {
    if (typeof limit !== "number" || typeof spent !== "number") continue;
    if (spent >= limit) return { kind, spent, limit };
  }
  return null;
}

/** The same check at the warning fraction, for the one-per-session heads-up. */
export function approaching(spend: Spend, budgets: Budgets): BudgetBreach | null {
  const fraction = budgets.warnAtFraction;
  if (typeof fraction !== "number" || fraction <= 0 || fraction >= 1) return null;
  const scaled: Budgets = {
    ...budgets,
    sessionUsd: budgets.sessionUsd === null ? null : budgets.sessionUsd * fraction,
    projectUsd: budgets.projectUsd === null ? null : budgets.projectUsd * fraction,
    contextPercent: budgets.contextPercent === null ? null : budgets.contextPercent * fraction,
  };
  // Only a warning while the real ceiling is still ahead. Past it there is
  // nothing to warn about, because the stop has already happened.
  if (breach(spend, budgets)) return null;
  return breach(spend, scaled);
}

const UNITS: Record<BudgetBreach["kind"], (n: number) => string> = {
  session: (n) => `$${n.toFixed(2)}`,
  project: (n) => `$${n.toFixed(2)}`,
  context: (n) => `${Math.round(n)}%`,
};

const WHAT: Record<BudgetBreach["kind"], string> = {
  session: "this chat's spend limit",
  project: "this project's spend limit",
  context: "this chat's context limit",
};

/**
 * What the *model* is told, as the denied tool call's result.
 *
 * Written as a settled fact with no remedy offered, which is the whole point.
 * Spike 2 showed that a denial naming its own fix reliably produces a retry; a
 * budget stop is the one denial where a retry is exactly what must not happen,
 * so this names no fix and offers no alternative. It asks for a summary instead,
 * because the spike found the model closes with one anyway - so the turn ends
 * with something useful rather than with a bare refusal.
 */
export function stopReason(b: BudgetBreach): string {
  return (
    `Stopped: ${WHAT[b.kind]} of ${UNITS[b.kind](b.limit)} has been reached ` +
    `(${UNITS[b.kind](b.spent)} used). No further tool calls will run in this session. ` +
    `Do not retry and do not look for another way to do this. ` +
    `Summarise what you finished and what is left, then stop.`
  );
}

/** What the *user* is told, which unlike the model's version does say what to
 *  do about it. */
export function stopNotice(b: BudgetBreach): string {
  return (
    `This chat hit ${WHAT[b.kind]} of ${UNITS[b.kind](b.limit)} (${UNITS[b.kind](b.spent)} used) ` +
    `and stopped before its next tool call. Raise the limit in Settings to carry on.`
  );
}

export function warnNotice(b: BudgetBreach, budgets: Budgets): string {
  const ceiling =
    b.kind === "session" ? budgets.sessionUsd : b.kind === "project" ? budgets.projectUsd : budgets.contextPercent;
  return (
    `This chat has used ${UNITS[b.kind](b.spent)} of ${WHAT[b.kind]}` +
    (typeof ceiling === "number" ? ` (${UNITS[b.kind](ceiling)})` : "") +
    `. It will stop when the limit is reached.`
  );
}
