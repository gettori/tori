// The forge status the sidebar reads, and the schedule that keeps it current.
//
// The thin half of the pair: `forgePoll.ts` owns every decision with its inputs
// explicit, this owns the timer, the invoke, and the signals. Same shape as
// `sessionActivity.ts` (fed inputs at the top, owned state below), and for the
// same reason: whoever knows a fact tells the store, and everyone else reads it
// rather than fetching their own copy.
//
// Nothing here is per-unit. One tick asks Rust about a whole project at once,
// because the rate budget scales with unit count and a per-unit request is what
// spends 5,000 an hour on an idle window.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { isForgeError, type AuthState, type StatusReport, type UnitStatus } from "./forgeTypes";
import {
  askOrder,
  backoffAfter,
  budgetBackoff,
  mayPoll,
  pauseReason,
  POLL_INTERVAL_MS,
  type PauseReason,
  type PollClock,
  type Trigger,
} from "./forgePoll";

/// A branch-unit as the poller needs it: what to ask about, and whether anyone
/// is looking at it. `branch` is null for a `plain-dir` unit, which has none.
export type WatchedUnit = { branch: string | null; visible: boolean };
export type WatchedProject = { path: string; units: readonly WatchedUnit[] };

// --- fed inputs -------------------------------------------------------------

const [auth, setAuth] = createSignal<AuthState>({ kind: "signedOut" });
const [enabled, setEnabled] = createSignal(true);
const [projects, setProjects] = createSignal<readonly WatchedProject[]>([]);

/** The credential state, from whoever last asked Rust for it. */
export function noteForgeAuth(state: AuthState) {
  setAuth(state);
}

/** The `github.enabled` kill switch, from the settings store. */
export function noteForgeEnabled(on: boolean) {
  setEnabled(on);
}

/** The projects worth polling and which of their units are on screen. Rebuilt
 *  whenever the sidebar's config or expansion changes. */
export function noteWatchedProjects(list: readonly WatchedProject[]) {
  setProjects(list);
}

// --- owned state ------------------------------------------------------------

const [statuses, setStatuses] = createSignal<Record<string, UnitStatus>>({});
const [uncovered, setUncovered] = createSignal<Record<string, number>>({});
/** Epoch ms before which *nothing* may poll. A rate limit belongs to the token,
 *  so one project hitting it stops them all. */
const [accountBlockedUntil, setAccountBlockedUntil] = createSignal<number | null>(null);
/** Per-project blocks, for the failures that belong to one repo (no origin, a
 *  remote this forge does not serve). */
const [projectBlocked, setProjectBlocked] = createSignal<Record<string, number>>({});
const [lastPollAt, setLastPollAt] = createSignal<Record<string, number>>({});

const key = (path: string, branch: string) => `${path}\n${branch}`;

/** One unit's forge story, or null when no tick has covered it yet. */
export function unitStatus(path: string, branch: string | null): UnitStatus | null {
  if (branch === null || branch === "") return null;
  return statuses()[key(path, branch)] ?? null;
}

/** Units of this project the last tick did not cover. Surfaced rather than
 *  swallowed: a partial answer rendered as a complete one leaves units with no
 *  chip and nothing on screen saying why. */
export function uncoveredUnits(path: string): number {
  return uncovered()[path] ?? 0;
}

/** Why polling is stopped, or null when it is running. */
export function forgePause(): PauseReason | null {
  return pauseReason(auth(), enabled());
}

/** Epoch ms until which the account is backed off, or null. */
export function forgeBlockedUntil(): number | null {
  return accountBlockedUntil();
}

function clockFor(path: string): PollClock {
  const account = accountBlockedUntil();
  const project = projectBlocked()[path] ?? null;
  const blockedUntil =
    account === null ? project : project === null ? account : Math.max(account, project);
  return { lastPollAt: lastPollAt()[path] ?? null, blockedUntil };
}

function applyReport(path: string, report: StatusReport, now: number) {
  setStatuses((m) => {
    const next = { ...m };
    for (const s of report.statuses) next[key(path, s.headRef)] = s;
    return next;
  });
  setUncovered((m) => ({ ...m, [path]: report.uncovered }));
  // A project that answered is a project whose remote is fine again.
  setProjectBlocked((m) => {
    if (!(path in m)) return m;
    const next = { ...m };
    delete next[path];
    return next;
  });
  // The pre-emptive half of the rate story: slow down while there is still
  // budget left, so the request that gets refused is never the user's.
  const budget = budgetBackoff(report.rate, now);
  if (budget) setAccountBlockedUntil(budget.untilMs);
}

async function noteFailure(path: string, err: unknown, now: number) {
  const backoff = backoffAfter(err, now);
  if (backoff?.scope === "account") setAccountBlockedUntil(backoff.untilMs);
  if (backoff?.scope === "project") setProjectBlocked((m) => ({ ...m, [path]: backoff.untilMs }));
  // Rust has already decided the credential cannot be used: a 401 moved it to
  // suspect, or `may_call` refused before the request was built. Re-reading the
  // state is what turns that into a paused scheduler and a prompt, rather than a
  // tick that fails the same way every two minutes forever. Both kinds matter,
  // because the decision can also be made by a *different* command (a PR create
  // that got the 401), leaving this store's copy of the auth state stale.
  if (isForgeError(err) && (err.kind === "credentialSuspect" || err.kind === "notAuthenticated")) {
    const state = await invoke<AuthState>("github_auth_state").catch(() => null);
    if (state) setAuth(state);
  }
}

async function pollProject(project: WatchedProject, trigger: Trigger, now: number) {
  if (!mayPoll(clockFor(project.path), trigger, now, auth(), enabled())) return;
  const branches = askOrder(project.units);
  if (branches.length === 0) return;
  // Stamped before the await, so two triggers landing together do not both get
  // past the gap check. Rust coalesces the duplicate anyway; this stops it from
  // reaching Rust at all.
  setLastPollAt((m) => ({ ...m, [project.path]: now }));
  try {
    const report = await invoke<StatusReport>("github_unit_statuses", {
      projectPath: project.path,
      branches,
      // Only an explicit refresh bypasses Rust's freshness window. A focus or an
      // interval tick is happy with an answer from the last few seconds.
      refresh: trigger === "manual",
    });
    applyReport(project.path, report, now);
  } catch (e) {
    await noteFailure(project.path, e, now);
  }
}

/// One tick over every watched project.
///
/// `now` is a parameter so a test can drive the schedule without a fake clock.
export async function pollNow(trigger: Trigger, now: number = Date.now()) {
  await Promise.all(projects().map((p) => pollProject(p, trigger, now)));
}

/// Starts the background schedule: an interval, plus a tick whenever the window
/// comes back to the front.
///
/// Focus matters more than the interval does. Coming back to Sway after a build
/// finished is exactly when the chips are stale, and waiting out the rest of a
/// two-minute interval to notice is the difference between a live surface and a
/// stale one. The gap in `forgePoll` is what stops that from becoming a request
/// per alt-tab.
export function startForgePolling(): () => void {
  const onFocus = () => void pollNow("focus");
  window.addEventListener("focus", onFocus);
  const timer = window.setInterval(() => void pollNow("interval"), POLL_INTERVAL_MS);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.clearInterval(timer);
  };
}

/// Drops every signal back to its starting value.
///
/// Named for what it is, like `resetSessionActivityForTests`: the store is
/// process-wide, so one test's rate-limit block would otherwise silence the
/// next, and nothing in the app should ever call this.
export function resetForgeStatusForTests() {
  setAuth({ kind: "signedOut" });
  setEnabled(true);
  setProjects([]);
  setStatuses({});
  setUncovered({});
  setAccountBlockedUntil(null);
  setProjectBlocked({});
  setLastPollAt({});
}
