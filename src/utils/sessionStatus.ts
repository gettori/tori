// The shared status vocabulary: the four states Sway can detect, what to call
// them, and the rollup arithmetic over a set of them. Pure and stateless.
//
// The composed list itself belongs to `sessionActivity`, which owns the probe,
// PTY-activity and tail-state inputs it is built from. Keeping the vocabulary
// separate is what lets `sessionDot` depend on it without depending on any of
// that machinery.
// Type-only, so the pair stays a one-way value dependency (sessionDot imports
// `dotFromStatus` from here) rather than a runtime import cycle.
import type { SessionDot, StatusCertainty } from "./sessionDot";

export type SessionStatus =
  | "executing"
  /** Blocked on a permission prompt. */
  | "waitingForApproval"
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
  waitingForApproval: "Waiting for approval",
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
): { title: string; exact: boolean } {
  const label = STATUS_LABEL[status];
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
export function dotFromStatus(status: SessionStatus): SessionDot {
  switch (status) {
    case "executing":
      return "working";
    case "waitingForApproval":
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
  /** The branch the session's transcript recorded, joined from the session
   *  store rather than read off the tab: a tab descriptor carries no branch,
   *  and without one a plain repo's sibling branch units - which share a single
   *  `folderPath` - cannot tell their sessions apart. Absent for a session with
   *  no transcript yet, and for one that recorded no branch. */
  recordedBranch?: string;
  /** Joined from the same place, for the one attribution case that turns on it:
   *  a branchless session's files are whatever the checkout currently is. */
  agent?: string;
};

export type Rollup = {
  waitingForApproval: number;
  executing: number;
  idle: number;
  running: number;
};

// Pure: aggregate counts of every detectable state across a set of sessions
// (a branch unit's, a project's, or a space's), for a collapsed/hidden ancestor
// row's badge.
export function rollupStatuses(sessions: { status: SessionStatus }[]): Rollup {
  const r: Rollup = { waitingForApproval: 0, executing: 0, idle: 0, running: 0 };
  for (const s of sessions) {
    if (s.status === "waitingForApproval") r.waitingForApproval++;
    else if (s.status === "executing") r.executing++;
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
