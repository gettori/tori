import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthState, ForgeAccount, RepoAccount, StatusReport, UnitStatus } from "./forgeTypes";
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
/** Rust's accounts, as `forge_accounts` answers. */
let accountList: ForgeAccount[] = [];
let accountReads = 0;
let viewerReads = 0;
let viewerAnswer: string | null = null;
/** What each checkout resolves to. Anything unlisted acts as `personal`. */
let repoOf: Record<string, RepoAccount> = {};
/** Queued answers to `forge_unit_statuses`, one per call. A value is resolved,
 *  an Error is rejected; running out falls back to an empty report. */
let answers: (StatusReport | Error)[] = [];
/** The projects each `autopilot_pickup` was asked for, in order. */
const pickups: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "forge_accounts") {
      accountReads += 1;
      return Promise.resolve([{ host: "github.com", accounts: accountList }]);
    }
    if (cmd === "forge_repo_account") {
      return Promise.resolve(repoOf[args?.projectPath as string] ?? on("personal"));
    }
    if (cmd === "forge_viewer") {
      viewerReads += 1;
      return viewerAnswer
        ? Promise.resolve(viewerAnswer)
        : Promise.reject(new Error("not signed in"));
    }
    if (cmd === "autopilot_pickup") {
      pickups.push(args?.projectPath as string);
      return Promise.resolve(null);
    }
    if (cmd === "forge_unit_statuses") {
      asks.push(args as unknown as Ask);
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? report([]));
    }
    return Promise.resolve(null);
  },
}));

import {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  resolveForgeRepo,
  startForgePolling,
  unitStatus,
  uncoveredUnits,
  forgeOrgNotice,
  forgePause,
  forgeViewer,
  noteForgeCliInstalled,
  mergeWatched,
  prWatchProjects,
  topicProjects,
  type WatchedProject,
} from "./forgeStatus";
import type { Topic } from "./topics";

const NOW = 1_785_179_400_000;
const SIGNED_IN: AuthState = { kind: "signedIn", login: "skarif2" };

function account(id: string, auth: AuthState): ForgeAccount {
  return {
    id,
    provider: "github",
    baseUrl: "https://github.com",
    login: auth.kind === "signedIn" ? auth.login : null,
    label: id,
    expiresAt: null,
    rejectedAt: null,
    scopes: null,
    source: "token",
    orgAccess: [],
    auth,
  };
}

const CAPS = {
  pullRequests: true,
  checks: true,
  reviewThreads: true,
  resolveThreads: true,
  merge: true,
  approve: true,
  requestChanges: true,
  commentReview: true,
  singleComment: true,
};

function on(accountId: string): RepoAccount {
  return {
    kind: "account",
    accountId,
    host: "github.com",
    auth: { kind: "signedIn", login: accountId },
    capabilities: CAPS,
  };
}

/** One account, `personal`, in this state, told to Rust and the store alike.
 *  Signed out is no account at all, which is what Rust answers then. */
function noteAuth(state: AuthState) {
  accountList = state.kind === "signedOut" ? [] : [account("personal", state)];
  noteForgeAccounts(accountList);
}

function status(head: string, over: Partial<UnitStatus> = {}): UnitStatus {
  return {
    headRef: head,
    pullRequest: null,
    checks: { state: "success", total: 1, failing: 0, contexts: [] },
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

/** Drain the microtask queue, however many awaits deep the work sits. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function signedInWith(projects: WatchedProject[], accounts = [account("personal", SIGNED_IN)]) {
  // Rust's answer too, not just the store's copy. `startForgePolling` re-reads
  // the credentials at mount and Rust is the authority, so a stub that still
  // said "signed out" would quietly undo this line.
  accountList = accounts;
  noteForgeAccounts(accounts);
  noteForgeEnabled(true);
  noteWatchedProjects(projects);
}

beforeEach(() => {
  asks.length = 0;
  answers = [];
  accountList = [];
  accountReads = 0;
  viewerReads = 0;
  viewerAnswer = null;
  repoOf = {};
  resetForgeStatusForTests();
});

// The identity behind the review gate. Approve and request-changes are refused
// with a 422 on your own pull request, so who "you" are decides which buttons
// exist at all, and an answer from a credential that is no longer signed in is
// the one way that gate can be wrong without looking wrong.
describe("the viewer identity", () => {
  /** The identity as a checkout acting as `personal` reads it. */
  const viewer = async () => {
    await resolveForgeRepo("/a");
    return forgeViewer("/a");
  };

  it("is learned when a credential becomes usable", async () => {
    viewerAnswer = "skarif2";
    noteAuth(SIGNED_IN);
    await flush();
    expect(await viewer()).toBe("skarif2");
  });

  it("does not survive a sign-out", async () => {
    viewerAnswer = "skarif2";
    noteAuth(SIGNED_IN);
    await flush();

    noteAuth({ kind: "signedOut" });
    expect(await viewer(), "an identity outlived its credential").toBeNull();
  });

  it("does not survive a rejected credential", async () => {
    // Rust keeps the login through a suspicion so the re-auth prompt can name
    // the account it wants back. That is a label. This is an authorisation
    // fact, and only one of the two is allowed to outlive a 401.
    viewerAnswer = "skarif2";
    noteAuth(SIGNED_IN);
    await flush();

    noteAuth({ kind: "suspect", login: "skarif2" });
    expect(await viewer()).toBeNull();
  });

  it("is re-derived when a different account signs in", async () => {
    // Sign out, sign back in as somebody else. Reusing the first identity would
    // have the review gate answering "whose pull request is this?" for an
    // account that is no longer signed in.
    viewerAnswer = "skarif2";
    noteAuth(SIGNED_IN);
    await flush();
    expect(viewerReads).toBe(1);

    noteAuth({ kind: "signedOut" });
    viewerAnswer = "someone-else";
    noteAuth({ kind: "signedIn", login: "someone-else" });
    await flush();

    expect(await viewer()).toBe("someone-else");
    expect(viewerReads).toBe(2);
  });

  it("is not re-asked while the same account stays signed in", async () => {
    // The credential state is re-read on every window focus, and an identity
    // request per focus is a request spent to learn what has not changed.
    viewerAnswer = "skarif2";
    noteAuth(SIGNED_IN);
    await flush();
    noteAuth(SIGNED_IN);
    noteAuth(SIGNED_IN);
    await flush();
    expect(viewerReads).toBe(1);
  });
});

describe("a Topic's members", () => {
  const topic = (members: Topic["members"]): Topic => ({ id: "t", name: "Auth", branch: "auth", members, createdAt: 0 });
  const member = (repoPath: string, mode: "reference" | "worktree"): Topic["members"][number] => ({
    repoPath,
    displayName: repoPath,
    mode,
    worktreePath: mode === "worktree" ? `${repoPath}/.tori/worktrees/auth` : null,
    state: { kind: "present" },
    order: 0,
  });

  it("asks about the Topic branch in a plain repo, and never for a reference that was never promoted", async () => {
    const watched = topicProjects(
      [{ topic: topic([member("/api", "worktree"), member("/web", "reference"), member("/docs", "reference")]), visible: true }],
      (repo) => repo === "/docs",
    );
    signedInWith(mergeWatched([[project("/api", ["main"])], watched]));
    await pollNow("interval", NOW);
    const asked = Object.fromEntries(asks.map((a) => [a.projectPath, a.branches]));
    expect(asked["/api"]).toEqual(["main", "auth"]);
    expect(asked["/docs"]).toEqual(["auth"]);
    expect(asked["/web"]).toBeUndefined();
  });
});

describe("a watched pull request", () => {
  it("is polled on its head branch even when its project is in no active space", async () => {
    signedInWith(mergeWatched([[project("/api", ["main"])], prWatchProjects([{ project: "/lib", branch: "fix" }])]));
    await pollNow("interval", NOW);
    const asked = Object.fromEntries(asks.map((a) => [a.projectPath, a.branches]));
    expect(asked["/api"]).toEqual(["main"]);
    expect(asked["/lib"]).toEqual(["fix"]);
  });
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
    // The deferred half of the `forge.enabled` promise, and the same for the
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
      noteAuth(state);
      noteForgeEnabled(enabled);
      noteWatchedProjects([project("/a", ["main"])]);
      await pollNow("interval", NOW);
      await pollNow("manual", NOW);
      expect(forgePause("/a")).not.toBeNull();
      expect(asks.length, `${why} kept polling`).toBe(0);
    }
  });

  it("asks for the assigned pickup once per project a tick polls, and never while disabled", async () => {
    // Pickup rides this tick rather than a clock of its own, so it is paused
    // exactly when the status poll is, the kill switch included.
    pickups.length = 0;
    signedInWith([project("/a", ["main"]), { path: "/b", units: [{ branch: null, visible: true }] }]);
    await pollNow("interval", NOW);
    expect(pickups).toEqual(["/a", "/b"]);
    resetForgeStatusForTests();
    pickups.length = 0;
    noteAuth(SIGNED_IN);
    noteForgeEnabled(false);
    noteWatchedProjects([project("/a", ["main"])]);
    await pollNow("interval", NOW);
    expect(pickups).toEqual([]);
  });

  it("spends the tick on the units that are on screen", async () => {
    // Rust caps the ask, so the order this sends is what decides which units get
    // covered and which come back as `uncovered`. Sending the raw list would
    // make that fall on whatever order the sidebar happened to build.
    noteAuth(SIGNED_IN);
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
  it("stops every project on the account when it hits a primary limit", async () => {
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

  it("keeps one account's rate limit off another account's projects", async () => {
    // Each token has its own hourly budget, so a limit on one is no reason to
    // stop a project that polls as the other.
    repoOf = { "/b": on("work") };
    signedInWith(
      [project("/a", ["main"]), project("/b", ["main"])],
      [account("personal", SIGNED_IN), account("work", { kind: "signedIn", login: "globex-arif" })],
    );
    answers = [forgeError("rateLimited", { rateLimitKind: "primary" }), report([status("main")])];
    await pollNow("interval", NOW);
    asks.length = 0;

    await pollNow("interval", NOW + MIN_GAP_MS);
    expect(asks.map((a) => a.projectPath)).toEqual(["/b"]);
  });

  it("pauses only the projects of an account whose token was rejected", async () => {
    repoOf = { "/b": on("work") };
    signedInWith(
      [project("/a", ["main"]), project("/b", ["main"])],
      [account("personal", SIGNED_IN), account("work", { kind: "suspect", login: "globex-arif" })],
    );
    await pollNow("interval", NOW);
    expect(asks.map((a) => a.projectPath)).toEqual(["/a"]);
    expect(forgePause("/b")).toBe("suspect");
    expect(forgePause("/a")).toBeNull();
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
    accountList = [account("personal", { kind: "suspect", login: "skarif2" })];
    answers = [forgeError("credentialSuspect")];
    await pollNow("interval", NOW);

    expect(accountReads).toBe(1);
    expect(forgePause("/a")).toBe("suspect");
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
    accountList = [account("personal", { kind: "suspect", login: "skarif2" })];
    answers = [forgeError("notAuthenticated")];
    await pollNow("interval", NOW);

    expect(accountReads).toBe(1);
    expect(forgePause("/a")).toBe("suspect");
  });

  it("recovers on the normal interval after an offline stretch", async () => {
    // No backoff for a transport failure: the request never left the machine, so
    // there is nothing to pace, and sulking would leave Tori quiet for minutes
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

  it("ticks the moment the credential becomes usable", async () => {
    // Every tick before sign-in was refused by the pause, and none of them is
    // retried on its own. Without this the app sits looking signed-out for the
    // rest of the interval after the user has just signed in - and the same
    // applies at launch, where the credential is read asynchronously and can
    // easily land after the sidebar has already asked for its first tick.
    noteForgeEnabled(true);
    noteWatchedProjects([project("/a", ["main"])]);
    await pollNow("interval", NOW);
    expect(asks.length, "polled while signed out").toBe(0);

    noteAuth(SIGNED_IN);
    await flush();
    expect(asks.length).toBe(1);

    // A repeated auth read is not news and must never become a request. Two
    // guards say so here (only a transition triggers, and the per-project gap
    // would refuse it anyway); the assertion is on the outcome they share,
    // since the focus tick this fires reads the wall clock and cannot be
    // driven far enough forward to isolate one of them.
    noteAuth(SIGNED_IN);
    await flush();
    expect(asks.length).toBe(1);
  });

  it("ticks when the window comes back to the front", async () => {
    // Coming back to Tori after a build finished is exactly when the chips are
    // stale, and waiting out the rest of the interval to notice it is the
    // difference between a live surface and a stale one.
    signedInWith([project("/a", ["main"])]);
    const stop = startForgePolling();
    window.dispatchEvent(new Event("focus"));
    // A focus tick re-reads the credentials and resolves the checkout before it
    // asks anything, so the request sits several microtasks deep.
    await flush();
    expect(asks.length).toBe(1);

    stop();
    asks.length = 0;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(asks.length, "the listener outlived its owner").toBe(0);
  });

  it("ticks on its own while the window sits untouched", async () => {
    vi.useFakeTimers();
    signedInWith([project("/a", ["main"])]);
    const stop = startForgePolling();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    await flush();
    expect(asks.length).toBe(1);

    stop();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    await flush();
    expect(asks.length, "the interval outlived its owner").toBe(1);
  });
});

describe("an organisation standing in front of a repo", () => {
  /** One tick that fails the way Rust reports a blocked organisation. */
  async function pollInto(err: Error, source: ForgeAccount["source"] = "token") {
    const acme = { ...account("personal", SIGNED_IN), source };
    signedInWith([project("/acme", ["main"])], [acme]);
    answers = [err];
    await pollNow("focus", NOW);
    await flush();
  }

  it("says nothing about a plain 404, which names no organisation to say it about", async () => {
    // A repo that is simply gone reads the same on the wire. Rust is the one
    // that tells the two apart, so a `notFound` reaching here is the answer
    // that it could not, and inventing a notice would send the user to
    // authorize an organisation that is not in the way.
    await pollInto(forgeError("notFound"));
    expect(forgeOrgNotice("/acme")).toBeNull();
  });

  it("offers a token account the CLI, since gh's own application was let in long ago", async () => {
    noteForgeCliInstalled(true);
    await pollInto(forgeError("orgUnapproved", { org: "acme", message: "acme has not approved Tori" }));
    expect(forgeOrgNotice("/acme")).toEqual({
      org: "acme",
      route: "cli",
      message: "acme has not approved Tori.",
      action: "Sign in with GitHub CLI",
    });
  });

  it("offers a cli account a token instead, because it has already spent that route", async () => {
    noteForgeCliInstalled(true);
    await pollInto(forgeError("orgUnapproved", { org: "acme" }), "cli");
    expect(forgeOrgNotice("/acme")?.route).toBe("token");
    expect(forgeOrgNotice("/acme")?.action).toBe("Paste a classic token");
  });

  it("clears the notice on the first tick the repo answers", async () => {
    noteForgeCliInstalled(true);
    await pollInto(forgeError("orgUnapproved", { org: "acme" }));
    expect(forgeOrgNotice("/acme")).not.toBeNull();

    answers = [report([status("main")])];
    await pollNow("manual", NOW + MIN_GAP_MS + 1);
    await flush();
    expect(forgeOrgNotice("/acme")).toBeNull();
  });
});
