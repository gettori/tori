// The shared status vocabulary: the four states Tori can detect, what to call
// them, and the rollup arithmetic over a set of them. Pure and stateless.
//
// The composed list itself belongs to `sessionActivity`, which reads the dots
// Rust composes.

/** The sidebar dot Rust composes for a session (`rpc/dots.rs`). */
export type SessionDot = "solid" | "hollow" | "working" | "needsYou" | "none";

/** How Tori came to know a dot: measured from the session's own event stream,
 *  or inferred from a probe plus a transcript tail. Rendered only on the exact
 *  side, because marking the inferred side would change how every pre-chat
 *  session renders. */
export type StatusCertainty = "exact" | "inferred";

/** The unit row a session sits under, as Rust placed it: its project, the
 *  unit's folder, and for a plain repo the branch that tells siblings apart. */
export type SessionHome = { project: string; folder: string; branch: string | null };

export type SessionStatus =
  | "executing"
  /** The parent's turn is over, but subagents or backgrounded tasks it started
   *  are still running. Counted as working wherever work matters (rollups, the
   *  revert guard, the tab pulse), because the folder is still changing. */
  | "waitingOnBackground"
  /** Blocked on a permission prompt. */
  | "waitingForApproval"
  /** Blocked on a question the agent asked (AskUserQuestion and its kin).
   *  Its own status rather than folded into `waitingForApproval`, because the
   *  label is read out loud in tooltips and a multiple-choice question is not
   *  an approval; both raise the same needs-you dot, which is what the
   *  notification, the tray and the tab marker key on. */
  | "waitingForAnswer"
  /** Stopped at a spend ceiling. Distinct from `waitingForApproval` because it
   *  is not a question with a yes: the session will not continue until a limit
   *  is raised, and labelling it "waiting for approval" would send the user
   *  looking for a prompt that does not exist. Both map to the same dot, since
   *  both mean the same thing to the person deciding what to look at next. */
  | "budgetStopped"
  | "idle"
  | "running"
  | "none";

export const STATUS_LABEL: Record<Exclude<SessionStatus, "none">, string> = {
  executing: "Executing",
  waitingOnBackground: "Waiting on background work",
  waitingForApproval: "Waiting for approval",
  waitingForAnswer: "Waiting for an answer",
  budgetStopped: "Stopped: budget reached",
  idle: "Idle",
  running: "Running",
};

/**
 * How a session row presents one status: its tooltip, and whether it wears the
 * exact-tier marker.
 *
 * Pure and separate from the JSX so the one rule that matters here is testable
 * without mounting a 2600-line sidebar: **only the exact side is marked**. The
 * obvious alternative - labelling the inferred side "(inferred)" - would change
 * how every PTY agent tab and every external session has rendered since before
 * chat existed, which is the one thing Phase 11 promised not to do and what the
 * golden status fixture is there to catch. So the certainty tiering is
 * expressed by *adding* to the side that gained certainty (see
 * `concept_evidence_tiered_attribution`).
 */
export function statusPresentation(
  status: Exclude<SessionStatus, "none">,
  certainty: StatusCertainty,
  label: string = STATUS_LABEL[status],
): { title: string; exact: boolean } {
  return certainty === "exact" ? { title: `${label} (measured)`, exact: true } : { title: label, exact: false };
}

// Mirrors LeftSidebar.tsx's `sessionDot` output ("solid" | "hollow" | "working"
// | "needsYou" | "none") onto the Antigravity vocabulary.
export function statusFromDot(dot: string): SessionStatus {
  switch (dot) {
    case "working":
      return "executing";
    case "needsYou":
      return "waitingForApproval";
    case "solid":
      return "idle";
    case "hollow":
      return "running";
    default:
      return "none";
  }
}

// The exact inverse of `statusFromDot`, for the chat tier, which knows its
// status directly and has to hand it *back* to the dot-shaped presence
// pipeline (OS notification, tray, dock badge). Those consumers were written
// against dots, and a second presence pipeline keyed on statuses would be two
// implementations of "is anything waiting on me" that could disagree.
/** Is a person being asked something they can answer here and now? Stated once
 *  so the tab marker, the jump-to-next hotkey and the stop command cannot end
 *  up with three different ideas of which prompts count. */
export function awaitingUser(status: SessionStatus): status is "waitingForApproval" | "waitingForAnswer" {
  return status === "waitingForApproval" || status === "waitingForAnswer";
}

/** Is the session going nowhere without the user? A budget stop blocks the same
 *  way, with nothing to answer. */
export function blockedOnUser(status: SessionStatus): boolean {
  return awaitingUser(status) || status === "budgetStopped";
}

/** Is work still going on in this session's folder? Stated once so the rollups,
 *  the revert guard and the tab pulse agree on it. */
export function isWorking(status: SessionStatus): boolean {
  return status === "executing" || status === "waitingOnBackground";
}

// The app socket's vocabulary, for callers outside the webview.
export function socketState(status: SessionStatus): "working" | "needs_you" | "idle" | null {
  if (isWorking(status) || status === "running") return "working";
  if (blockedOnUser(status)) return "needs_you";
  return status === "idle" ? "idle" : null;
}

/** Outstanding background work in the words a status line uses, e.g.
 *  `Waiting: 2 agents, 1 task`. */
export function backgroundLabel(counts: { agents: number; tasks: number }): string {
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : null);
  return `Waiting: ${[part(counts.agents, "agent"), part(counts.tasks, "task")].filter(Boolean).join(", ")}`;
}

export function dotFromStatus(status: SessionStatus): SessionDot {
  switch (status) {
    case "executing":
    case "waitingOnBackground":
      return "working";
    case "waitingForApproval":
    case "waitingForAnswer":
    case "budgetStopped":
      return "needsYou";
    case "idle":
      return "solid";
    case "running":
      return "hollow";
    default:
      return "none";
  }
}

export type LiveSessionStatus = {
  sessionId: string;
  status: SessionStatus;
  sessionName: string;
  spaceName: string;
  projectName: string;
  folderPath: string;
  tabId: string;
  /** The unit row Rust placed the session under, which a plain repo's sibling
   *  units (sharing one `folderPath`) need to tell their sessions apart. */
  home?: SessionHome | null;
  /** The agent, joined from the session store, since a tab carries none. */
  agent?: string;
};

export type Rollup = {
  waitingForApproval: number;
  waitingForAnswer: number;
  executing: number;
  idle: number;
  running: number;
};

// Pure: aggregate counts of every detectable state across a set of sessions
// (a branch unit's, a project's, or a space's), for a collapsed/hidden ancestor
// row's badge.
export function rollupStatuses(sessions: { status: SessionStatus }[]): Rollup {
  const r: Rollup = { waitingForApproval: 0, waitingForAnswer: 0, executing: 0, idle: 0, running: 0 };
  for (const s of sessions) {
    if (s.status === "waitingForApproval") r.waitingForApproval++;
    else if (s.status === "waitingForAnswer") r.waitingForAnswer++;
    else if (isWorking(s.status)) r.executing++;
    else if (s.status === "idle") r.idle++;
    else if (s.status === "running") r.running++;
  }
  return r;
}

// The composed list itself lives in `sessionActivity`, which owns the probe,
// PTY-activity and tail-state inputs it is built from. This module stays the
// pure vocabulary: the states, their labels, and the rollup arithmetic over
// them. It used to also hold a published *copy* of the list, written by
// LeftSidebar on every change, because the composition lived in that component
// and nothing else could reach it. A copy is one tick behind its source and one
// more place for the two to disagree, so with the composition in a store of its
// own there is nothing left for it to do.
