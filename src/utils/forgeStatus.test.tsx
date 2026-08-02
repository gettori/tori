import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthState, StatusReport, UnitStatus } from "./forgeTypes";
import { MIN_GAP_MS, POLL_INTERVAL_MS, PRIMARY_BACKOFF_MS } from "./forgePoll";

// The scheduler driven end to end, with the Tauri boundary as the meter.
//
// `.tsx` with no JSX in it, on purpose: the test config splits environments by
// extension, and the background schedule is a window focus listener plus a
// window interval, neither of which exists in the node project.
//
// Every assertion here is about **requests not made**. A poller that fetches too
// much still renders correctly, so nothing on screen ever says it is wrong: the
// only symptom is the hourly budget running out, hours later, on whatever the
// user happened to click next. That is why the counts are asserted rather than
// argued.

type Ask = { projectPath: string; branches: string[]; refresh: boolean };

const asks: Ask[] = [];
let authState: AuthState = { kind: "signedOut" };
let authStateReads = 0;
/** Queued answers to `github_unit_statuses`, one per call. A value is resolved,
 *  an Error is rejected; running out falls back to an empty report. */
let answers: (StatusReport | Error)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "github_auth_state") {
      authStateReads += 1;
      return Promise.resolve(authState);
    }
    if (cmd === "github_unit_statuses") {
      asks.push(args as unknown as Ask);
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? report([]));
    }
    return Promise.resolve(null);
  },
}));

import {
  noteForgeAuth,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  startForgePolling,
  unitStatus,
  uncoveredUnits,
  forgePause,
  type WatchedProject,
} from "./forgeStatus";

const NOW = 1_785_179_400_000;

function status(head: string, over: Partial<UnitStatus> = {}): UnitStatus {
  return {
    headRef: head,
    pullRequest: null,
    checks: { state: "success", total: 1, failing: 0 },
    reviewDecision: "none",
    ...over,
  };
}

function report(statuses: UnitStatus[], over: Partial<StatusReport> = {}): StatusReport {
  return {
    statuses,
    uncovered: 0,
    rate: { remaining: null, limit: 5000, resetAt: null },
    ...over,
  };
}

/** A rejected forge command, as Tauri hands it back: the serialized DTO. */
const forgeError = (kind: string, over: Record<string, unknown> = {}) =>
  Object.assign(new Error(kind), {
    kind,
    message: kind,
    rateLimitKind: null,
    retryAfterSecs: null,
    resetAtSecs: null,
    ...over,
  });

const project = (path: string, branches: string[]) => ({
  path,
  units: branches.map((b) => ({ branch: b, visible: true })),
});

function signedInWith(projects: WatchedProject[]) {
  noteForgeAuth({ kind: "signedIn", login: "skarif2" });
  noteForgeEnabled(true);
  noteWatchedProjects(projects);
}

beforeEach(() => {
  asks.length = 0;
  answers = [];
  authState = { kind: "signedOut" };
  authStateReads = 0;
  resetForgeStatusForTests();
});

describe("the poll schedule", () => {
  it("asks once per project per tick, whatever the unit count", () => {
    // The batched shape is the whole rate story: one request covers the project,
    // so twenty units cost what one does.
    const twenty = Array.from({ length: 20 }, (_, i) => `wave-${i}`);
    signedInWith([project("/a", twenty)]);
    return pollNow("interval", NOW).then(() => {
      expect(asks.length).toBe(1);
      expect(asks[0].branches).toEqual(twenty);
      expect(asks[0].refresh).toBe(false);
    });
  });

  it("issues no request at all in each paused state", async () => {
    // The deferred half of the `github.enabled` promise, and the same for the
    // two credential states. A disabled integration that keeps polling is the
    // failure the kill switch exists to prevent.
    const cases: [AuthState, boolean, string][] = [
      [{ kind: "signedOut" }, true, "signed out"],
      [{ kind: "suspect", login: "skarif2" }, true, "suspect"],
      [{ kind: "signedIn", login: "skarif2" }, false, "disabled"],
    ];
    for (const [state, enabled, why] of cases) {
      resetForgeStatusForTests();
      asks.length = 0;
      noteForgeAuth(state);
      noteForgeEnabled(enabled);
      noteWatchedProjects([project("/a", ["main"])]);
      expect(forgePause()).not.toBeNull();
      await pollNow("interval", NOW);
      await pollNow("manual", NOW);
      expect(asks.length, `${why} kept polling`).toBe(0);
    }
  });

  it("spends the tick on the units that are on screen", async () => {
    // Rust caps the ask, so the order this sends is what decides which units get
    // covered and which come back as `uncovered`. Sending the raw list would
    // make that fall on whatever order the sidebar happened to build.
    noteForgeAuth({ kind: "signedIn", login: "skarif2" });
    noteForgeEnabled(true);
    noteWatchedProjects([
      {
        path: "/a",
        units: [
          { branch: "stale-1", visible: false },
          { branch: "wave-3", visible: true },
          { branch: "stale-2", visible: false },
        ],
      },
    ]);
    await pollNow("interval", NOW);
    expect(asks[0].branches).toEqual(["wave-3", "stale-1", "stale-2"]);
  });

  it("does not poll a project whose units have no branches", async () => {
    // A folder of `plain-dir` units has nothing the forge could answer for, and
    // asking would spend a request to be told so.
    signedInWith([{ path: "/a", units: [{ branch: null, visible: true }] }]);
    await pollNow("interval", NOW);
    expect(asks.length).toBe(0);
  });

  it("collapses two triggers landing together into one request", async () => {
    // The focus-plus-interval collision. Both callers still get the right
    // answer, which is exactly why this is invisible without a counter.
    signedInWith([project("/a", ["main"])]);
    await Promise.all([pollNow("focus", NOW), pollNow("interval", NOW)]);
    expect(asks.length).toBe(1);
  });

  it("lets the next interval through once the gap has passed", async () => {
    signedInWith([project("/a", ["main"])]);
    await pollNow("interval", NOW);
    await pollNow("focus", NOW + 1_000);
    expect(asks.length, "the focus arrived inside the gap").toBe(1);
    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.length).toBe(2);
  });

  it("marks a manual refresh as one, so Rust bypasses its cache", async () => {
    signedInWith([project("/a", ["main"])]);
    await pollNow("manual", NOW);
    expect(asks[0].refresh).toBe(true);
  });
});

describe("what a tick brings back", () => {
  it("files each status under its own unit", async () => {
    signedInWith([project("/a", ["main", "wave-3"])]);
    answers = [report([status("main"), status("wave-3", { reviewDecision: "changesRequested" })])];
    await pollNow("interval", NOW);
    expect(unitStatus("/a", "main")?.headRef).toBe("main");
    expect(unitStatus("/a", "wave-3")?.reviewDecision).toBe("changesRequested");
    // A unit no tick has covered is null, which is not the same as a unit with
    // no PR: one is "not known yet", the other is an answer.
    expect(unitStatus("/a", "never-asked")).toBeNull();
    expect(unitStatus("/b", "main")).toBeNull();
  });

  it("keeps the count of units the tick could not cover", async () => {
    // Silently dropping them would render a partial answer as a complete one.
    signedInWith([project("/a", ["main"])]);
    answers = [report([status("main")], { uncovered: 7 })];
    await pollNow("interval", NOW);
    expect(uncoveredUnits("/a")).toBe(7);
    expect(uncoveredUnits("/b")).toBe(0);
  });
});

describe("backing off", () => {
  it("stops every project when the account hits a primary limit", async () => {
    // The limit belongs to the token, not the repo, so a second project polling
    // straight through it would keep the block from ever ending.
    signedInWith([project("/a", ["main"]), project("/b", ["main"])]);
    answers = [forgeError("rateLimited", { rateLimitKind: "primary" }), new Error("unused")];
    await pollNow("interval", NOW);
    asks.length = 0;

    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.length, "the 403 did not stop the other project").toBe(0);

    await pollNow("interval", NOW + PRIMARY_BACKOFF_MS);
    expect(asks.length).toBe(2);
  });

  it("waits out a secondary limit by the seconds the server named", async () => {
    signedInWith([project("/a", ["main"])]);
    answers = [forgeError("rateLimited", { rateLimitKind: "secondary", retryAfterSecs: 45 })];
    await pollNow("interval", NOW);
    asks.length = 0;

    await pollNow("manual", NOW + 44_000);
    expect(asks.length, "a manual refresh does not outrank a throttle").toBe(0);
    await pollNow("manual", NOW + 45_000);
    expect(asks.length).toBe(1);
  });

  it("keeps a project's own remote problem off every other project", async () => {
    signedInWith([project("/a", ["main"]), project("/b", ["main"])]);
    answers = [forgeError("noRemote"), report([status("main")])];
    await pollNow("interval", NOW);
    asks.length = 0;

    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.map((a) => a.projectPath)).toEqual(["/b"]);
  });

  it("slows down while there is still budget left", async () => {
    // The pre-emptive half. Backing off only once refused means the refusal
    // always lands on something the user clicked.
    signedInWith([project("/a", ["main"])]);
    answers = [
      report([status("main")], {
        rate: { remaining: 12, limit: 5000, resetAt: NOW / 1000 + 300 },
      }),
    ];
    await pollNow("interval", NOW);
    asks.length = 0;

    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.length).toBe(0);
    await pollNow("interval", NOW + 300_000);
    expect(asks.length).toBe(1);
  });

  it("turns a rejected credential into a paused scheduler, not a repeating failure", async () => {
    // Rust has already marked the token suspect. Without re-reading it here the
    // scheduler would keep asking every tick and getting the same 401.
    signedInWith([project("/a", ["main"])]);
    authState = { kind: "suspect", login: "skarif2" };
    answers = [forgeError("credentialSuspect")];
    await pollNow("interval", NOW);

    expect(authStateReads).toBe(1);
    expect(forgePause()).toBe("suspect");
    asks.length = 0;
    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.length).toBe(0);
  });

  it("notices a credential another command got rejected", async () => {
    // The suspicion can be raised by a *different* call (a PR create that got
    // the 401), leaving this store's copy of the auth state stale. Rust refuses
    // before building a request, so nothing breaks, it just fails identically
    // every two minutes forever with the scheduler none the wiser.
    signedInWith([project("/a", ["main"])]);
    authState = { kind: "suspect", login: "skarif2" };
    answers = [forgeError("notAuthenticated")];
    await pollNow("interval", NOW);

    expect(authStateReads).toBe(1);
    expect(forgePause()).toBe("suspect");
  });

  it("recovers on the normal interval after an offline stretch", async () => {
    // No backoff for a transport failure: the request never left the machine, so
    // there is nothing to pace, and sulking would leave Sway quiet for minutes
    // after the network came back.
    signedInWith([project("/a", ["main"])]);
    answers = [forgeError("transport")];
    await pollNow("interval", NOW);
    asks.length = 0;
    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.length).toBe(1);
  });
});

describe("the background schedule", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks when the window comes back to the front", async () => {
    // Coming back to Sway after a build finished is exactly when the chips are
    // stale, and waiting out the rest of the interval to notice it is the
    // difference between a live surface and a stale one.
    signedInWith([project("/a", ["main"])]);
    const stop = startForgePolling();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(asks.length).toBe(1);

    stop();
    asks.length = 0;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(asks.length, "the listener outlived its owner").toBe(0);
  });

  it("ticks on its own while the window sits untouched", async () => {
    vi.useFakeTimers();
    signedInWith([project("/a", ["main"])]);
    const stop = startForgePolling();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    await Promise.resolve();
    expect(asks.length).toBe(1);

    stop();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    await Promise.resolve();
    expect(asks.length, "the interval outlived its owner").toBe(1);
  });
});
