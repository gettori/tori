import { describe, it, expect } from "vite-plus/test";
import plainTurn from "../../dev/fixtures/claude/plain-turn.jsonl?raw";
import readCall from "../../dev/fixtures/claude/read-call.jsonl?raw";
import {
  limitTypeChip,
  limitTypeInline,
  limitTypeLabel,
  limitTypeShort,
  scopedModel,
  paceOutAt,
  quotaState,
  readingsOf,
  resetsAtMs,
  windowSentence,
  type QuotaReading,
  type RateLimitState,
} from "./chatRateLimit";
import { applyEvent, initialChat } from "../panels/Chat/chatStore";

const SESSION = "11111111-2222-3333-4444-555555555555";
/** The shared threshold's default, so the table below reads the way the app does. */
const WARN_AT = 0.8;

type CapturedInfo = {
  status: string;
  resetsAt: number;
  rateLimitType: string;
  utilization?: number;
};

/** The `rate_limit_info` block exactly as claude wrote it. */
function captured(raw = plainTurn): CapturedInfo {
  for (const line of raw.split("\n").filter(Boolean)) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === "rate_limit_event") return o.rate_limit_info as CapturedInfo;
  }
  throw new Error("the capture has no rate_limit_event");
}

const reading = (over: Partial<QuotaReading> = {}): QuotaReading => ({
  kind: "five_hour",
  utilization: null,
  resetsAt: captured().resetsAt,
  status: null,
  reachedType: null,
  ...over,
});

/** An hour before the captured reset, so nothing under test is expired by
 *  accident. Every case that wants expiry says so. */
const NOW = captured().resetsAt * 1000 - 60 * 60 * 1000;

describe("the captured rate_limit_event", () => {
  // The measurement the whole trigger rule rests on: every frame on this
  // transport says `allowed`, and one fires per turn.
  it("reports an allowed status", () => {
    expect(captured().status).toBe("allowed");
  });

  // The bug this module was rewritten for: five captured frames say
  // `allowed_warning`, which the predecessor read as a limit already hit.
  it("also reports allowed_warning, with a level and no limit in force", () => {
    const warn = captured(readCall);
    expect(warn.status).toBe("allowed_warning");
    expect(warn.utilization).toBe(0.88);
  });

  // The unit trap. 1785179400 read as milliseconds is January 1970; the
  // fixture's own magnitude is what makes the two scales distinguishable, which
  // a round test number would not.
  it("carries resetsAt in seconds, not milliseconds", () => {
    const seconds = captured().resetsAt;
    expect(new Date(seconds * 1000).getUTCFullYear()).toBe(2026);
    // The bug this pins: taking the field as millis lands three decades early.
    expect(new Date(seconds).getUTCFullYear()).toBe(1970);
    expect(resetsAtMs(seconds)).toBe(seconds * 1000);
  });
});

describe("quotaState", () => {
  it("says nothing for the status every capture reports", () => {
    expect(quotaState(reading({ status: "allowed", utilization: 0.15 }), WARN_AT, NOW)).toBe("ok");
  });

  // `reached` outranks the level: the source refusing work is evidence, and 97%
  // is only arithmetic that has not got there yet.
  it("is reached on a rejected status well under 100%", () => {
    expect(quotaState(reading({ status: "rejected", utilization: 0.97 }), WARN_AT, NOW)).toBe("reached");
  });

  // Codex reports no status at all, only its own hit flag and a percentage.
  it("is reached on a source's own hit flag with no status", () => {
    expect(quotaState(reading({ utilization: 1, reachedType: "primary" }), WARN_AT, NOW)).toBe("reached");
    expect(quotaState(reading({ utilization: 0.5, reachedType: "primary" }), WARN_AT, NOW)).toBe("reached");
  });

  it("is reached at a full window with nothing else said about it", () => {
    expect(quotaState(reading({ utilization: 1 }), WARN_AT, NOW)).toBe("reached");
  });

  it("is approaching for the captured allowed_warning frame", () => {
    const warn = captured(readCall);
    const r = reading({
      kind: "seven_day",
      status: warn.status,
      utilization: warn.utilization,
      resetsAt: warn.resetsAt,
    });
    expect(quotaState(r, WARN_AT, warn.resetsAt * 1000 - 1000)).toBe("approaching");
  });

  it("is approaching once the level crosses the threshold", () => {
    expect(quotaState(reading({ utilization: 0.65 }), 0.6, NOW)).toBe("approaching");
    expect(quotaState(reading({ utilization: 0.55 }), 0.6, NOW)).toBe("ok");
  });

  // The "off" stop on the shared control. It silences the heads-up and nothing
  // else: a limit already in force is never something the user opted out of.
  it("never warns at a threshold of 1, but still reports a limit in force", () => {
    expect(quotaState(reading({ utilization: 0.99 }), 1, NOW)).toBe("ok");
    expect(quotaState(reading({ status: "allowed_warning", utilization: 0.88 }), 1, NOW)).toBe("ok");
    expect(quotaState(reading({ status: "rejected" }), 1, NOW)).toBe("reached");
    expect(quotaState(reading({ utilization: 1 }), 1, NOW)).toBe("reached");
  });

  // Expiry is checked before any of it: a level from a window that has since
  // reset is a memory, not a level.
  it("is expired once the reset has passed, whatever the level said", () => {
    const past = captured().resetsAt * 1000 + 1000;
    expect(quotaState(reading({ utilization: 0.75 }), WARN_AT, past)).toBe("expired");
    expect(quotaState(reading({ status: "rejected", utilization: 1 }), WARN_AT, past)).toBe("expired");
  });

  // Not on any list, so not droppable: a limit nobody has a name for is still a
  // limit. Approaching, because an unknown word is not evidence of a stop.
  it("surfaces a status it has never seen as approaching", () => {
    expect(quotaState(reading({ status: "some_new_status" }), WARN_AT, NOW)).toBe("approaching");
  });

  it("treats an empty status with no level as nothing to say", () => {
    expect(quotaState(reading({ status: "" }), WARN_AT, NOW)).toBe("ok");
  });
});

describe("windowSentence", () => {
  it("says nothing at ok", () => {
    expect(windowSentence(reading({ status: "allowed" }), WARN_AT, NOW)).toBeNull();
  });

  it("names the window and when it resets", () => {
    const msg = windowSentence(reading({ status: "rejected" }), WARN_AT, NOW);
    expect(msg).toContain("5-hour");
    expect(msg).toContain("Resets");
  });

  // The wire's own word never reaches the user. "has been reached
  // (allowed_warning)" was two wrong things in one sentence.
  it("reports a level without leaking the wire's status token", () => {
    const warn = captured(readCall);
    const r = reading({
      kind: "seven_day",
      status: warn.status,
      utilization: warn.utilization,
      resetsAt: warn.resetsAt,
    });
    const msg = windowSentence(r, WARN_AT, warn.resetsAt * 1000 - 1000);
    expect(msg).toContain("88%");
    expect(msg).toContain("weekly all-model");
    expect(msg).not.toContain("allowed_warning");
    expect(msg).not.toContain("reached");
  });

  // No percentage on an expired window: the level belongs to a quota that no
  // longer exists.
  it("reports a reset without the level it used to hold", () => {
    const past = captured().resetsAt * 1000 + 1000;
    const msg = windowSentence(reading({ utilization: 0.75 }), WARN_AT, past);
    expect(msg).toBe("Your rolling 5-hour limit has reset.");
    expect(msg).not.toContain("75");
  });

  it("still says something useful when the source sent no reset time", () => {
    const msg = windowSentence(reading({ status: "rejected", resetsAt: null }), WARN_AT, NOW);
    expect(msg).toContain("rolling 5-hour");
    expect(msg).not.toContain("Resets");
  });

  it("falls back to a generic subject for a window it cannot name", () => {
    expect(windowSentence(reading({ kind: "", status: "rejected" }), WARN_AT, NOW)).toContain("A usage limit");
  });
});

describe("limitTypeLabel", () => {
  const DOT = " \u00b7 ";

  it("spells out the wire's machine identifiers", () => {
    expect(limitTypeLabel("five_hour")).toBe(`Session${DOT}5h rolling`);
    expect(limitTypeLabel("seven_day")).toBe(`Week${DOT}all models`);
  });

  // Three lengths of one vocabulary. The titlebar has room for none of the long
  // ones, and no card name survives being dropped into "your ... limit".
  it("has a titlebar-width name and a sentence-shaped one for the same window", () => {
    expect(limitTypeShort("five_hour")).toBe("5H");
    expect(limitTypeShort("seven_day")).toBe("W");
    // A letter, because the strip draws three of these beside three bars and the
    // bar is what carries the meaning.
    expect(limitTypeShort("seven_day_fable")).toBe("F");
    expect(limitTypeInline("five_hour")).toBe("rolling 5-hour");
    expect(limitTypeInline("seven_day_fable")).toBe("weekly Fable");
    // The settings chip is a word: it is the control, and has to read before
    // the strip's letters have been learned.
    expect(limitTypeChip("seven_day")).toBe("Week");
    expect(limitTypeChip("seven_day_fable")).toBe("Fable");
    expect(limitTypeChip("five_hour")).toBe("5H");
  });

  it("passes an unknown one through rather than dropping it", () => {
    expect(limitTypeLabel("thirty_minute")).toBe("thirty_minute");
    expect(limitTypeLabel(null)).toBeNull();
  });

  // The account-token rung names these after whichever model the endpoint
  // scoped the window to, so the model's own name is titled rather than looked
  // up. What is looked up is only whether it is a model at all.
  it("names a model-scoped weekly window after its model", () => {
    expect(limitTypeLabel("seven_day_fable")).toBe(`Week${DOT}Fable only`);
    expect(limitTypeLabel("seven_day_opus")).toBe(`Week${DOT}Opus only`);
    // A display name the endpoint slugged whole, not a bare family word.
    expect(limitTypeLabel("seven_day_claude_opus_4_5")).toBe(`Week${DOT}Claude opus 4 5 only`);
    expect(limitTypeLabel("extra_usage")).toBe("Extra usage");
  });

  // The endpoint spells its non-model weeks exactly like its model ones, and a
  // capture of a Max account carries three of them. Read as models they become
  // "Week - Overage included only", a model nobody has and cannot pick.
  it("reads a weekly window scoped to something that is not a model as a qualifier", () => {
    expect(scopedModel("seven_day_overage_included")).toBeNull();
    expect(limitTypeLabel("seven_day_overage_included")).toBe(`Week${DOT}overage included`);
    expect(limitTypeLabel("seven_day_oauth_apps")).toBe(`Week${DOT}oauth apps`);
    expect(limitTypeLabel("seven_day_cowork")).toBe(`Week${DOT}cowork`);
  });

  it("gives that window the same three lengths as any other", () => {
    // A letter on the strip, a word on the settings chip, a phrase in a
    // sentence: the shapes each surface has room for, whatever it is scoped to.
    expect(limitTypeShort("seven_day_overage_included")).toBe("O");
    expect(limitTypeChip("seven_day_overage_included")).toBe("Overage included");
    expect(limitTypeInline("seven_day_overage_included")).toBe("weekly overage included");
  });
});

describe("readingsOf", () => {
  const base: RateLimitState = {
    status: "allowed",
    resetsAt: 1_788_519_600,
    limitType: "five_hour",
    utilization: null,
    windows: [],
    overageStatus: "rejected",
  };

  it("takes every window a unifiedWindows frame named", () => {
    const out = readingsOf({
      ...base,
      windows: [
        { kind: "five_hour", utilization: 0.15, resetsAt: 1_788_519_600 },
        { kind: "seven_day", utilization: 0.35, resetsAt: 1_788_742_800 },
      ],
    });
    expect(out.map((r) => [r.kind, r.utilization])).toEqual([
      ["five_hour", 0.15],
      ["seven_day", 0.35],
    ]);
  });

  // The status is about `rateLimitType` alone, so carrying it onto every window
  // would mark a weekly quota as reached because the five-hour one was.
  it("puts the frame's status only on the window it is about", () => {
    const out = readingsOf({
      ...base,
      status: "rejected",
      limitType: "five_hour",
      windows: [
        { kind: "five_hour", utilization: 1, resetsAt: 1_788_519_600 },
        { kind: "seven_day", utilization: 0.35, resetsAt: 1_788_742_800 },
      ],
    });
    expect(out.map((r) => r.status)).toEqual(["rejected", null]);
  });

  it("falls back to the one window a frame without unifiedWindows named", () => {
    const out = readingsOf({ ...base, status: "allowed_warning", limitType: "seven_day", utilization: 0.88 });
    expect(out).toEqual([
      { kind: "seven_day", utilization: 0.88, resetsAt: base.resetsAt, status: "allowed_warning", reachedType: null },
    ]);
  });

  it("has nothing to report before any event has arrived", () => {
    expect(readingsOf(null)).toEqual([]);
  });
});

describe("the store's rate-limit state", () => {
  const event = (over: Partial<Extract<Parameters<typeof applyEvent>[1], { type: "rateLimit" }>> = {}) => ({
    type: "rateLimit" as const,
    sessionId: SESSION,
    status: "allowed",
    resetsAt: captured().resetsAt,
    limitType: "five_hour",
    utilization: null,
    windows: [],
    overageStatus: "rejected",
    ...over,
  });

  it("records the captured frame without deciding anything about it", () => {
    const c = captured();
    const s = initialChat(SESSION);
    expect(s.rateLimit).toBeNull();
    applyEvent(s, event({ status: c.status, resetsAt: c.resetsAt, limitType: c.rateLimitType }));
    expect(s.rateLimit).toEqual({
      status: "allowed",
      resetsAt: c.resetsAt,
      limitType: "five_hour",
      utilization: null,
      windows: [],
      overageStatus: "rejected",
    });
    // Recorded, but not worth a banner - which is the split under test.
    expect(readingsOf(s.rateLimit).map((r) => quotaState(r, WARN_AT, NOW))).toEqual(["ok"]);
  });

  it("keeps only the newest frame, so a lifted limit clears the banner", () => {
    const s = initialChat(SESSION);
    applyEvent(s, event({ status: "rejected" }));
    expect(readingsOf(s.rateLimit).map((r) => quotaState(r, WARN_AT, NOW))).toEqual(["reached"]);

    applyEvent(s, event({ status: "allowed" }));
    expect(readingsOf(s.rateLimit).map((r) => quotaState(r, WARN_AT, NOW))).toEqual(["ok"]);
  });
});

// The pace line is the one thing on the card that is a projection rather than a
// reading, so what it must not do is speak when it has nothing to say.
describe("paceOutAt", () => {
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  /** A five-hour window that started two hours ago. */
  const resetsAt = Math.floor((now + FIVE_HOURS - 2 * 60 * 60 * 1000) / 1000);
  const win = (utilization: number | null, kind = "five_hour", at = resetsAt): QuotaReading => ({
    kind,
    utilization,
    resetsAt: at,
    status: null,
    reachedType: null,
  });

  // 60% of the window in the first two of its five hours: at that rate the whole
  // of it is gone after 3h20m, an hour and forty before the reset.
  it("projects the moment the window runs out when that lands before the reset", () => {
    const out = paceOutAt(win(0.6), now);
    expect(out).not.toBeNull();
    expect(Math.round((out! - now) / 60_000)).toBe(80);
  });

  // The whole point of the line: a projection landing after the reset says you
  // are fine, which the bar already said.
  it("is null when the projection lands after the reset", () => {
    expect(paceOutAt(win(0.2), now)).toBeNull();
    // Exactly on pace is not ahead of it either.
    expect(paceOutAt(win(0.4), now)).toBeNull();
  });

  it("is null with nothing to project from", () => {
    expect(paceOutAt(win(null), now)).toBeNull();
    expect(paceOutAt(win(0), now)).toBeNull();
  });

  // Already reached or already reset: the projection is about a future that has
  // happened, and the bar says so in words.
  it("is null once the window is full or past its reset", () => {
    expect(paceOutAt(win(1), now)).toBeNull();
    expect(paceOutAt(win(0.6, "five_hour", Math.floor(now / 1000) - 60), now)).toBeNull();
  });

  // No source sends the window's start, so the duration comes from the kind's
  // own name. A kind with no known duration gets no projection rather than one
  // built on a guessed length.
  it("is null for a window kind whose length is not known", () => {
    expect(paceOutAt(win(0.6, "seven_day_opus"), now)).toBeNull();
  });
});
