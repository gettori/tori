// When a chat has spent enough to be stopped, and what the user is told when it
// is.
//
// Pure, so the one thing that matters here - that a ceiling stops a session
// exactly once, at a boundary, with a message naming what to do about it - is
// testable without a running agent.
//
// **The stop lands at the turn boundary, and only the user is told.** It used to
// land at the next tool call, as a `PreToolUse` denial carrying a reason written
// to be un-arguable, because Tori's hook saw every call and could refuse one.
// Tori no longer decides tool calls at all: the agent asks in its own protocol
// and the hook only captures before-states. What Tori still owns outright is
// whether a *new turn* starts, so that is where the ceiling now sits.
//
// The consequence is deliberate and worth stating: a turn already running is
// allowed to finish. A ceiling can therefore be crossed by the turn that crosses
// it, and the stop applies to the next one. The alternative - interrupting a
// live turn - would end work mid-edit to save the fraction of a turn's cost that
// remained, which is the wrong trade for a limit measured in dollars per
// session.
//
// Nothing is told to the model any more. There is no denial to attach a reason
// to, and a message injected into the transcript to announce the ceiling would
// be a new turn: the exact thing being prevented.
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
 * What the user is told, and the only thing anyone is told.
 *
 * It has to name the remedy, because the user is now the only way past this: the
 * chat will refuse to start another turn until the limit moves, and a message
 * that reported the stop without saying where to raise it would leave a dead
 * chat with no visible way back.
 */
/**
 * The shared threshold as a label, wherever it is printed.
 *
 * 100% reads as **off**, because that is what it does: `approaching` above is
 * disabled outside (0, 1), for the ceilings and for the agents' quota windows
 * alike. Reaching a limit is never silenced by it.
 *
 * Here rather than beside the slider because two screens print it now: the
 * control in Chat, and the read-only value on each agent's Usage block.
 */
export function warnAtLabel(v: number | undefined): string {
  return typeof v !== "number" || v >= 1 ? "off" : `${Math.round(v * 100)}%`;
}

export function stopNotice(b: BudgetBreach): string {
  return (
    `This chat hit ${WHAT[b.kind]} of ${UNITS[b.kind](b.limit)} (${UNITS[b.kind](b.spent)} used) ` +
    `and will not start another turn. Raise the limit in Settings to carry on.`
  );
}

/** Shown when a message is typed or queued into a stopped chat, rather than
 *  sending it. Distinct from `stopNotice`: that one announces the stop, this one
 *  answers "why did nothing happen when I pressed send". */
export function heldNotice(b: BudgetBreach): string {
  return (
    `This message is waiting: ${WHAT[b.kind]} of ${UNITS[b.kind](b.limit)} has been reached. ` +
    `Raise the limit in Settings and send again.`
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
