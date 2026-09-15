import { describe, it, expect } from "vitest";
import {
  askOrder,
  backoffAfter,
  budgetBackoff,
  mayPoll,
  pauseReason,
  projectPause,
  MIN_GAP_MS,
  PRIMARY_BACKOFF_MS,
  SECONDARY_BACKOFF_MS,
  NO_REMOTE_BACKOFF_MS,
  RATE_FLOOR,
  type PollClock,
} from "./forgePoll";
import type { AuthState, ForgeErrorDto, RateSnapshot, RepoAccount } from "./forgeTypes";

const SIGNED_IN: AuthState = { kind: "signedIn", login: "skarif2" };
const NOW = 1_785_179_400_000;
const idle: PollClock = { lastPollAt: null, blockedUntil: null };

const err = (kind: string, over: Partial<ForgeErrorDto> = {}): ForgeErrorDto => ({
  kind,
  message: "…",
  rateLimitKind: null,
  retryAfterSecs: null,
  resetAtSecs: null,
  ...over,
});

const rate = (over: Partial<RateSnapshot> = {}): RateSnapshot => ({
  remaining: null,
  limit: 5000,
  resetAt: null,
  ...over,
});

describe("pauseReason", () => {
  it("names which of the three noes stopped the poller", () => {
    // Naming it is the point. "Unavailable" leaves the user with nothing to do;
    // each of these has a different next action (turn it back on, sign in, sign
    // back in as the same account).
    expect(pauseReason({ kind: "signedOut" }, true)).toBe("signedOut");
    expect(pauseReason({ kind: "suspect", login: "skarif2" }, true)).toBe("suspect");
    expect(pauseReason(SIGNED_IN, false)).toBe("disabled");
    expect(pauseReason(SIGNED_IN, true)).toBeNull();
  });

  it("reads a switched-off integration as off, whatever the credential", () => {
    // The user turned it off deliberately, so that is what they should be told,
    // rather than being invited to sign in to something they disabled.
    expect(pauseReason({ kind: "signedOut" }, false)).toBe("disabled");
    expect(pauseReason({ kind: "suspect", login: "skarif2" }, false)).toBe("disabled");
  });
});

describe("mayPoll", () => {
  it("stops for every reason polling should stop", () => {
    for (const [auth, enabled] of [
      [{ kind: "signedOut" } as AuthState, true],
      [{ kind: "suspect", login: "skarif2" } as AuthState, true],
      [SIGNED_IN, false],
    ] as const) {
      const pause = pauseReason(auth, enabled);
      expect(mayPoll(idle, "interval", NOW, pause)).toBe(false);
      expect(mayPoll(idle, "focus", NOW, pause)).toBe(false);
      // Even a manual refresh: a paused integration has nothing to refresh with.
      expect(mayPoll(idle, "manual", NOW, pause)).toBe(false);
    }
  });

  it("polls a project it has never polled", () => {
    expect(mayPoll(idle, "interval", NOW, null)).toBe(true);
  });

  it("collapses a focus storm into one tick", () => {
    // Alt-tabbing fires focus repeatedly. Without the gap every one of those is
    // a request, which is how an idle window spends the hourly budget.
    const justPolled: PollClock = { lastPollAt: NOW - 1_000, blockedUntil: null };
    expect(mayPoll(justPolled, "focus", NOW, null)).toBe(false);

    const older: PollClock = { lastPollAt: NOW - MIN_GAP_MS, blockedUntil: null };
    expect(mayPoll(older, "focus", NOW, null)).toBe(true);
  });

  it("lets a manual refresh through the gap but not through a backoff", () => {
    // The user asked, so the gap yields. The rate limit does not: hitting
    // refresh during a throttle is how a throttle becomes a longer one.
    const justPolled: PollClock = { lastPollAt: NOW - 1_000, blockedUntil: null };
    expect(mayPoll(justPolled, "manual", NOW, null)).toBe(true);

    const blocked: PollClock = { lastPollAt: null, blockedUntil: NOW + 60_000 };
    expect(mayPoll(blocked, "manual", NOW, null)).toBe(false);
    expect(mayPoll(blocked, "interval", NOW, null)).toBe(false);
  });

  it("resumes the moment a backoff expires", () => {
    const expired: PollClock = { lastPollAt: null, blockedUntil: NOW };
    expect(mayPoll(expired, "interval", NOW, null)).toBe(true);
  });
});

describe("projectPause", () => {
  const auth = (id: string): AuthState =>
    id === "work" ? { kind: "suspect", login: "fonn-arif" } : SIGNED_IN;
  const on = (accountId: string): RepoAccount => ({
    kind: "account",
    accountId,
    host: "github.com",
    auth: auth(accountId),
  });

  it("pauses only the projects of the account that was rejected", () => {
    expect(projectPause(on("work"), auth, true)).toBe("suspect");
    expect(projectPause(on("personal"), auth, true)).toBeNull();
  });

  it("waits on a pick, and reads a host with no account as signed out", () => {
    expect(projectPause({ kind: "pick", host: "github.com", candidates: [] }, auth, true)).toBe(
      "pickAccount",
    );
    expect(projectPause({ kind: "noAccount", host: "github.com" }, auth, true)).toBe("signedOut");
    // No remote at all is Rust's `noRemote` to report, not a sign-in to ask for.
    expect(projectPause({ kind: "noAccount", host: null }, auth, true)).toBeNull();
    expect(projectPause(on("personal"), auth, false)).toBe("disabled");
  });
});

describe("backoffAfter", () => {
  it("waits out a secondary limit by the server's own number", () => {
    // The 429 case. GitHub names a `Retry-After` and ignoring it is what earns
    // a longer block, so the number is used rather than a constant of our own.
    const b = backoffAfter(err("rateLimited", { rateLimitKind: "secondary", retryAfterSecs: 45 }), NOW);
    expect(b).toEqual({ scope: "account", untilMs: NOW + 45_000 });
  });

  it("waits out a primary limit until the budget actually refills", () => {
    // The 403 case, which names no `Retry-After` but does say when the hourly
    // budget comes back. Ignoring that means waiting out a fixed guess instead:
    // either polling again while still blocked, or sitting idle long after the
    // budget returned.
    const b = backoffAfter(
      err("rateLimited", { rateLimitKind: "primary", resetAtSecs: 1_785_179_400 }),
      1_785_178_000_000,
    );
    expect(b).toEqual({ scope: "account", untilMs: 1_785_179_400_000 });

    // And an explicit `Retry-After` still wins: an instruction outranks a
    // refill time, which is what a 403 carrying both means.
    const both = backoffAfter(
      err("rateLimited", { rateLimitKind: "secondary", retryAfterSecs: 5, resetAtSecs: 1_785_179_400 }),
      NOW,
    );
    expect(both?.untilMs).toBe(NOW + 5_000);
  });

  it("tells the two rate limits apart when neither names a deadline", () => {
    // The 403 case. A primary limit is an hourly budget and a secondary one is
    // a few seconds of throttling; treating them the same means either hammering
    // through an hour-long block or sulking for fifteen minutes over a blip.
    expect(backoffAfter(err("rateLimited", { rateLimitKind: "primary" }), NOW)).toEqual({
      scope: "account",
      untilMs: NOW + PRIMARY_BACKOFF_MS,
    });
    expect(backoffAfter(err("rateLimited", { rateLimitKind: "secondary" }), NOW)).toEqual({
      scope: "account",
      untilMs: NOW + SECONDARY_BACKOFF_MS,
    });
  });

  it("keeps a repo's own problem to that repo", () => {
    // A rate limit belongs to the token and stops everything; a remote this
    // forge cannot serve belongs to one project. Blocking the account for a
    // GitLab checkout would let one unrelated project silence all the others.
    expect(backoffAfter(err("noRemote"), NOW)).toEqual({
      scope: "project",
      untilMs: NOW + NO_REMOTE_BACKOFF_MS,
    });
    expect(backoffAfter(err("unsupportedRemote"), NOW)?.scope).toBe("project");
  });

  it("does not back off for the failures that are not about pacing", () => {
    // An offline laptop retrying on the normal interval costs nothing: the
    // request never leaves the machine. And a suspect credential is already a
    // pause via the auth state, so timing it out too would keep polling stopped
    // for minutes after a re-sign-in.
    expect(backoffAfter(err("transport"), NOW)).toBeNull();
    expect(backoffAfter(err("credentialSuspect"), NOW)).toBeNull();
    expect(backoffAfter(err("api"), NOW)).toBeNull();
    expect(backoffAfter("a thrown string", NOW)).toBeNull();
  });
});

describe("budgetBackoff", () => {
  it("stops before the budget is gone, not after", () => {
    // Polling to exhaustion means the request that gets refused is the next one
    // the user clicks, which is the only one they will notice.
    const b = budgetBackoff(rate({ remaining: RATE_FLOOR - 1, resetAt: NOW / 1000 + 600 }), NOW);
    expect(b).toEqual({ scope: "account", untilMs: NOW + 600_000 });
  });

  it("reads the reset as seconds, not milliseconds", () => {
    // The captured value is epoch seconds; read as millis it is 1970, and the
    // block would expire instantly with nothing looking wrong.
    const b = budgetBackoff(rate({ remaining: 1, resetAt: 1_785_179_400 }), 1_785_178_000_000);
    expect(b?.untilMs).toBe(1_785_179_400_000);
  });

  it("treats a reset already past as over", () => {
    const b = budgetBackoff(rate({ remaining: 1, resetAt: NOW / 1000 - 60 }), NOW);
    expect(b?.untilMs).toBe(NOW);
  });

  it("says nothing when the response said nothing", () => {
    // A proxy that strips rate headers must read as no news. Treating a missing
    // count as zero would stop polling permanently on the first such response.
    expect(budgetBackoff(rate({ remaining: null }), NOW)).toBeNull();
    expect(budgetBackoff(rate({ remaining: RATE_FLOOR }), NOW)).toBeNull();
  });
});

describe("askOrder", () => {
  it("spends the tick's cap on what is on screen", () => {
    // The cap has to fall on something, and the only defensible thing is what
    // nobody is looking at.
    expect(
      askOrder([
        { branch: "old-1", visible: false },
        { branch: "wave-3", visible: true },
        { branch: "old-2", visible: false },
        { branch: "main", visible: true },
      ]),
    ).toEqual(["wave-3", "main", "old-1", "old-2"]);
  });

  it("drops units the forge could not answer for anyway", () => {
    // A `plain-dir` unit has no branch.
    expect(askOrder([{ branch: null, visible: true }, { branch: "", visible: true }])).toEqual([]);
  });
});
