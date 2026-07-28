import { describe, it, expect } from "vitest";
import plainTurn from "../../dev/fixtures/claude/plain-turn.jsonl?raw";
import { isLimited, limitTypeLabel, rateLimitMessage, resetsAtMs, type RateLimitState } from "./chatRateLimit";
import { applyEvent, initialChat } from "../panels/Chat/chatStore";

const SESSION = "11111111-2222-3333-4444-555555555555";

/** The `rate_limit_info` block exactly as claude wrote it. */
function captured(): { status: string; resetsAt: number; rateLimitType: string } {
  for (const line of plainTurn.split("\n").filter(Boolean)) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === "rate_limit_event") {
      return o.rate_limit_info as { status: string; resetsAt: number; rateLimitType: string };
    }
  }
  throw new Error("the capture has no rate_limit_event");
}

const state = (over: Partial<RateLimitState> = {}): RateLimitState => ({
  status: "rejected",
  resetsAt: captured().resetsAt,
  limitType: "five_hour",
  ...over,
});

describe("the captured rate_limit_event", () => {
  // The measurement the banner's whole trigger rule rests on: every frame on
  // this transport says `allowed`, and one fires per turn.
  it("reports an allowed status", () => {
    expect(captured().status).toBe("allowed");
  });

  // The unit trap. 1785179400 read as milliseconds is January 1970; the
  // fixture's own magnitude is what makes the two scales distinguishable, which
  // a round test number would not.
  it("carries resetsAt in seconds, not milliseconds", () => {
    const seconds = captured().resetsAt;
    expect(new Date(seconds * 1000).getUTCFullYear()).toBe(2026);
    // The bug this pins: taking the field as millis lands three decades early.
    expect(new Date(seconds).getUTCFullYear()).toBe(1970);
    expect(resetsAtMs(state())).toBe(seconds * 1000);
  });
});

describe("isLimited", () => {
  it("says nothing is wrong for the status every capture reports", () => {
    expect(isLimited(state({ status: "allowed" }))).toBe(false);
  });

  it("says nothing before any event has arrived", () => {
    expect(isLimited(null)).toBe(false);
  });

  it("surfaces a status it has never seen rather than hiding it", () => {
    expect(isLimited(state({ status: "some_new_status" }))).toBe(true);
  });

  it("treats an empty status as nothing to say", () => {
    expect(isLimited(state({ status: "" }))).toBe(false);
  });
});

describe("rateLimitMessage", () => {
  const NOW = captured().resetsAt * 1000 - 60 * 60 * 1000; // an hour before the reset

  // The verify's other half: the common case renders nothing at all.
  it("renders nothing for the captured allowed frame", () => {
    expect(rateLimitMessage(state({ status: "allowed" }), NOW)).toBeNull();
  });

  it("names the limit and when it resets", () => {
    const msg = rateLimitMessage(state(), NOW);
    expect(msg).toContain("5-hour");
    expect(msg).toContain("Resets at");
  });

  it("does not promise a future reset that has already passed", () => {
    const past = captured().resetsAt * 1000 + 1000;
    expect(rateLimitMessage(state(), past)).toContain("any moment now");
    expect(rateLimitMessage(state(), past)).not.toContain("Resets at");
  });

  it("still says something useful when the wire sent no reset time", () => {
    const msg = rateLimitMessage(state({ resetsAt: null }), NOW);
    expect(msg).toContain("5-hour");
    expect(msg).not.toContain("Resets at");
  });

  it("falls back to a generic subject when the limit type is unknown", () => {
    expect(rateLimitMessage(state({ limitType: null }), NOW)).toContain("A usage limit");
  });
});

describe("limitTypeLabel", () => {
  it("spells out the wire's machine identifiers", () => {
    expect(limitTypeLabel("five_hour")).toBe("5-hour");
    expect(limitTypeLabel("seven_day")).toBe("7-day");
  });

  it("passes an unknown one through rather than dropping it", () => {
    expect(limitTypeLabel("thirty_minute")).toBe("thirty_minute");
    expect(limitTypeLabel(null)).toBeNull();
  });
});

describe("the store's rate-limit state", () => {
  it("records the captured frame without deciding anything about it", () => {
    const c = captured();
    const s = initialChat(SESSION);
    expect(s.rateLimit).toBeNull();
    applyEvent(s, {
      type: "rateLimit",
      sessionId: SESSION,
      status: c.status,
      resetsAt: c.resetsAt,
      limitType: c.rateLimitType,
    });
    expect(s.rateLimit).toEqual({ status: "allowed", resetsAt: c.resetsAt, limitType: "five_hour" });
    // Recorded, but not worth a banner - which is the split under test.
    expect(rateLimitMessage(s.rateLimit, Date.now())).toBeNull();
  });

  it("keeps only the newest frame, so a lifted limit clears the banner", () => {
    const s = initialChat(SESSION);
    applyEvent(s, {
      type: "rateLimit",
      sessionId: SESSION,
      status: "rejected",
      resetsAt: captured().resetsAt,
      limitType: "five_hour",
    });
    expect(rateLimitMessage(s.rateLimit, Date.now())).not.toBeNull();

    applyEvent(s, {
      type: "rateLimit",
      sessionId: SESSION,
      status: "allowed",
      resetsAt: captured().resetsAt,
      limitType: "five_hour",
    });
    expect(rateLimitMessage(s.rateLimit, Date.now())).toBeNull();
  });
});
