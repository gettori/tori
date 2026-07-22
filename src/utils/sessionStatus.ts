// Shared Antigravity-style status vocabulary + rollup primitives (Phase 1).
// LeftSidebar.tsx still owns the actual composition (dot = f(probe, ptyActivity,
// tailState)); this module turns that dot into the four detectable states Sway
// can show, and exposes the composed list as a signal so a future consumer
// (command palette, next-waiting hotkey) can read every live-tab session's
// status without re-deriving it or being scoped to the active space.
import { createSignal } from "solid-js";

export type SessionStatus = "executing" | "waitingForApproval" | "idle" | "running" | "none";

export const STATUS_LABEL: Record<Exclude<SessionStatus, "none">, string> = {
  executing: "Executing",
  waitingForApproval: "Waiting for approval",
  idle: "Idle",
  running: "Running",
};

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

export type LiveSessionStatus = {
  sessionId: string;
  status: SessionStatus;
  sessionName: string;
  spaceName: string;
  projectName: string;
  folderPath: string;
  tabId: string;
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

const [liveStatuses, setLiveStatusesSignal] = createSignal<LiveSessionStatus[]>([]);
export { liveStatuses };

/// Called reactively by LeftSidebar (the sole owner of the underlying probe/
/// activity/tail-state composition) with every live-tab session's current
/// status, so any other component can read it without re-subscribing to that
/// composition itself.
export function setLiveStatuses(list: LiveSessionStatus[]) {
  setLiveStatusesSignal(list);
}
