// The schedule for a read Tori pays for itself.
//
// A fake clock throughout: every rule here is about elapsed time, and a test
// that waited out five minutes would be one nobody runs.
import { describe, it, expect } from "vitest";
import {
  BASE_BACKOFF_MS,
  MANUAL_GAP_MS,
  MAX_BACKOFF_MS,
  MIN_GAP_MS,
  POLL_INTERVAL_MS,
  backoffUntil,
  mayPoll,
  type PollClock,
  type PollContext,
} from "./usagePoll";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

const clock = (over: Partial<PollClock> = {}): PollClock => ({
  lastPollAt: null,
  blockedUntil: null,
  ...over,
});

const ctx = (over: Partial<PollContext> = {}): PollContext => ({
  visible: true,
  chatOpen: true,
  spawns: true,
  ...over,
});

describe("the first read", () => {
  it("runs for any trigger that has a reason to exist", () => {
    expect(mayPoll(clock(), "focus", NOW, ctx())).toBe(true);
    expect(mayPoll(clock(), "hover", NOW, ctx())).toBe(true);
    expect(mayPoll(clock(), "interval", NOW, ctx())).toBe(true);
  });
});

describe("a hidden window", () => {
  // Unconditional, and checked before everything else: there is no strip to
  // update behind another Space, and nothing else reads the answer.
  it("stops every trigger, including the one the user just made", () => {
    for (const trigger of ["focus", "hover", "interval"] as const) {
      expect(mayPoll(clock(), trigger, NOW, ctx({ visible: false })), trigger).toBe(false);
    }
  });
});

describe("the background tick", () => {
  it("needs a chat on this agent open before it spawns a process for one", () => {
    expect(mayPoll(clock(), "interval", NOW, ctx({ chatOpen: false }))).toBe(false);
    expect(mayPoll(clock(), "interval", NOW, ctx({ chatOpen: true }))).toBe(true);
  });

  it("runs with no chat open when the read spawns nothing", () => {
    // What the gate is rationing is a process. Held to it, the one-request rung
    // stopped reading the moment the last chat closed, and the strip went grey
    // fifteen minutes later with a live account behind it.
    expect(mayPoll(clock(), "interval", NOW, ctx({ chatOpen: false, spawns: false }))).toBe(true);
  });

  it("still waits out the interval and the hidden window for that read", () => {
    const quiet = ctx({ chatOpen: false, spawns: false });
    expect(mayPoll(clock(), "interval", NOW, { ...quiet, visible: false })).toBe(false);
    const c = clock({ lastPollAt: NOW });
    expect(mayPoll(c, "interval", NOW + POLL_INTERVAL_MS - 1, quiet)).toBe(false);
    expect(mayPoll(c, "interval", NOW + POLL_INTERVAL_MS, quiet)).toBe(true);
  });

  it("waits the full interval between runs", () => {
    const c = clock({ lastPollAt: NOW });
    expect(mayPoll(c, "interval", NOW + POLL_INTERVAL_MS - 1, ctx())).toBe(false);
    expect(mayPoll(c, "interval", NOW + POLL_INTERVAL_MS, ctx())).toBe(true);
  });
});

describe("focus and hover", () => {
  // The strip is on screen whether or not a chat is: a reading from yesterday
  // is exactly what a hover is asking about.
  it("run with no chat open at all", () => {
    expect(mayPoll(clock(), "focus", NOW, ctx({ chatOpen: false }))).toBe(true);
    expect(mayPoll(clock(), "hover", NOW, ctx({ chatOpen: false }))).toBe(true);
  });

  it("share one floor, so a storm of them is one read", () => {
    const c = clock({ lastPollAt: NOW });
    expect(mayPoll(c, "focus", NOW + MIN_GAP_MS - 1, ctx())).toBe(false);
    expect(mayPoll(c, "hover", NOW + MIN_GAP_MS - 1, ctx())).toBe(false);
    expect(mayPoll(c, "hover", NOW + MIN_GAP_MS, ctx())).toBe(true);
  });

  it("still beat the background tick to a fresh number", () => {
    const c = clock({ lastPollAt: NOW });
    const soon = NOW + MIN_GAP_MS;
    expect(mayPoll(c, "interval", soon, ctx())).toBe(false);
    expect(mayPoll(c, "focus", soon, ctx())).toBe(true);
  });
});

describe("switching the source on", () => {
  // The one trigger that is a decision rather than an event. Turning a rung on
  // has to produce the reading it promises, and on the token rung that is also
  // what puts the Keychain prompt next to the click that caused it.
  it("reads inside the floor a hover would wait out, but not twice in ten seconds", () => {
    const c = clock({ lastPollAt: NOW });
    expect(mayPoll(c, "hover", NOW + MANUAL_GAP_MS, ctx())).toBe(false);
    expect(mayPoll(c, "manual", NOW + MANUAL_GAP_MS, ctx())).toBe(true);
    // A refresh button hammered is the same endpoint asked back to back.
    expect(mayPoll(c, "manual", NOW + MANUAL_GAP_MS - 1, ctx())).toBe(false);
  });

  // A press refused for a backoff has nothing to show why; the answer is what
  // says it. A hidden window has nobody to show it to.
  it("runs inside a backoff, and still does nothing behind a hidden window", () => {
    expect(mayPoll(clock({ blockedUntil: NOW + 1 }), "manual", NOW, ctx())).toBe(true);
    expect(mayPoll(clock(), "manual", NOW, ctx({ visible: false }))).toBe(false);
  });
});

describe("a block", () => {
  // A hover during a backoff is how a throttle becomes a longer one, and the
  // thing being backed off from is usually not going to answer sooner.
  it("outlasts the user asking directly", () => {
    const c = clock({ blockedUntil: NOW + 60_000 });
    expect(mayPoll(c, "hover", NOW, ctx())).toBe(false);
    expect(mayPoll(c, "focus", NOW, ctx())).toBe(false);
    expect(mayPoll(c, "hover", NOW + 60_000, ctx())).toBe(true);
  });
});

describe("the backoff", () => {
  it("is nothing at all before the first failure", () => {
    expect(backoffUntil(0, NOW)).toBe(NOW);
  });

  it("doubles per consecutive failure", () => {
    expect(backoffUntil(1, NOW)).toBe(NOW + BASE_BACKOFF_MS);
    expect(backoffUntil(2, NOW)).toBe(NOW + BASE_BACKOFF_MS * 2);
    expect(backoffUntil(3, NOW)).toBe(NOW + BASE_BACKOFF_MS * 4);
  });

  // A missing binary fails instantly and forever, so without a cap the doubling
  // would be the only thing keeping the retry cheap, and with one the wait
  // stays short enough that installing codex is noticed within half an hour.
  it("stops doubling at the cap", () => {
    expect(backoffUntil(20, NOW)).toBe(NOW + MAX_BACKOFF_MS);
  });
});
