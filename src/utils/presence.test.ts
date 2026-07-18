import { describe, it, expect } from "vitest";
import { stepPresence, markAttended, liveCounts, unattendedNeedsYouCount, shouldSuppressNotification } from "./presence";

const empty = { attended: {}, lastDot: {} };

describe("stepPresence", () => {
  it("fires exactly once on the needsYou rising edge, not on every tick while it stays needsYou", () => {
    const first = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(first.transitioned).toEqual(["s1"]);

    const second = stepPresence(first.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(second.transitioned).toEqual([]);
  });

  it("a genuine re-block (via an intermediate non-needsYou dot) resets the session to unattended", () => {
    const blocked = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const attended = markAttended(blocked.state, "s1");
    expect(attended.attended.s1).toBe(true);

    // The steady state (still needsYou, no intervening change) must NOT
    // count as a re-block - attended stays true.
    const stillBlocked = stepPresence(attended, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(stillBlocked.transitioned).toEqual([]);
    expect(stillBlocked.state.attended.s1).toBe(true);

    // A genuine re-block (the agent resumed in between) resets attended.
    const resumed = stepPresence(stillBlocked.state, [{ sessionId: "s1", dot: "working" }]);
    const reblocked = stepPresence(resumed.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(reblocked.transitioned).toEqual(["s1"]);
    expect(reblocked.state.attended.s1).toBe(false);
  });

  it("attending doesn't suppress the next genuine transition (re-block after attended fires again)", () => {
    const blocked = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const attended = markAttended(blocked.state, "s1");

    // The agent resumes (working), then blocks again - a real re-block, not
    // a rerender of the same steady state.
    const resumed = stepPresence(attended, [{ sessionId: "s1", dot: "working" }]);
    expect(resumed.transitioned).toEqual([]);

    const reblocked = stepPresence(resumed.state, [{ sessionId: "s1", dot: "needsYou" }]);
    expect(reblocked.transitioned).toEqual(["s1"]);
  });

  it("tracks multiple sessions independently", () => {
    const step = stepPresence(empty, [
      { sessionId: "a", dot: "needsYou" },
      { sessionId: "b", dot: "working" },
    ]);
    expect(step.transitioned).toEqual(["a"]);

    const next = stepPresence(step.state, [
      { sessionId: "a", dot: "needsYou" }, // steady, no re-fire
      { sessionId: "b", dot: "needsYou" }, // b's own rising edge
    ]);
    expect(next.transitioned).toEqual(["b"]);
  });
});

describe("markAttended", () => {
  it("is a no-op for an already-attended session", () => {
    const step = stepPresence(empty, [{ sessionId: "s1", dot: "needsYou" }]);
    const once = markAttended(step.state, "s1");
    const twice = markAttended(once, "s1");
    expect(twice).toEqual(once);
  });
});

describe("liveCounts", () => {
  it("counts every non-none dot as running, needsYou as a subset", () => {
    const counts = liveCounts([
      { dot: "working" },
      { dot: "needsYou" },
      { dot: "solid" },
      { dot: "hollow" }, // detached sessions still count as running
      { dot: "none" },
    ]);
    expect(counts).toEqual({ running: 4, needsYou: 1 });
  });

  it("is zero/zero for no live sessions", () => {
    expect(liveCounts([])).toEqual({ running: 0, needsYou: 0 });
  });
});

describe("unattendedNeedsYouCount", () => {
  it("counts only needsYou sessions not yet attended", () => {
    const live = [
      { sessionId: "a", dot: "needsYou" },
      { sessionId: "b", dot: "needsYou" },
      { sessionId: "c", dot: "working" },
    ];
    expect(unattendedNeedsYouCount(live, {})).toBe(2);
    expect(unattendedNeedsYouCount(live, { a: true })).toBe(1);
    expect(unattendedNeedsYouCount(live, { a: true, b: true })).toBe(0);
  });
});

describe("shouldSuppressNotification", () => {
  it("suppresses only when the blocked session is both selected and the window is focused", () => {
    const event = { sessionId: "s1" };
    expect(shouldSuppressNotification(event, "s1", true)).toBe(true);
    expect(shouldSuppressNotification(event, "s1", false)).toBe(false); // selected but window unfocused
    expect(shouldSuppressNotification(event, "other", true)).toBe(false); // focused but a different tab
    expect(shouldSuppressNotification(event, undefined, true)).toBe(false);
  });
});
