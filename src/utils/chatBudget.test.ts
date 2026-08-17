import { describe, expect, it } from "vitest";
import { approaching, breach, heldNotice, stopNotice, warnNotice } from "./chatBudget";
import type { Budgets } from "../panels/Settings/settingsStore";

const NONE: Budgets = { sessionUsd: null, projectUsd: null, contextPercent: null, warnAtFraction: 0.8 };
const spend = (over: Partial<{ sessionUsd: number | null; projectUsd: number | null; contextPercent: number | null }> = {}) => ({
  sessionUsd: null,
  projectUsd: null,
  contextPercent: null,
  ...over,
});

describe("breach", () => {
  // The failure that would make this feature actively hostile: an unset ceiling
  // read as zero would stop every chat at its first turn.
  it("treats an unset ceiling as unlimited, never as zero", () => {
    expect(breach(spend({ sessionUsd: 999 }), NONE)).toBeNull();
    expect(breach(spend({ projectUsd: 999 }), NONE)).toBeNull();
    expect(breach(spend({ contextPercent: 100 }), NONE)).toBeNull();
  });

  it("says nothing until the ceiling is actually reached, and then names it", () => {
    const budgets = { ...NONE, sessionUsd: 5 };
    expect(breach(spend({ sessionUsd: 4.99 }), budgets)).toBeNull();
    expect(breach(spend({ sessionUsd: 5 }), budgets)).toEqual({ kind: "session", spent: 5, limit: 5 });
  });

  // A session that blew its own budget should say so rather than blaming the
  // project it happens to sit in.
  it("blames the session's own ceiling before the project's", () => {
    const budgets = { ...NONE, sessionUsd: 5, projectUsd: 10 };
    expect(breach(spend({ sessionUsd: 6, projectUsd: 11 }), budgets)?.kind).toBe("session");
    expect(breach(spend({ sessionUsd: 1, projectUsd: 11 }), budgets)?.kind).toBe("project");
  });

  // A ceiling set against a figure nothing has reported cannot fire: a agent
  // that reports no cost must not read as having spent nothing and be stopped
  // by a limit of 0.
  it("cannot fire on a figure that was never reported", () => {
    expect(breach(spend({ sessionUsd: null }), { ...NONE, sessionUsd: 0 })).toBeNull();
  });
});

describe("approaching", () => {
  it("warns on the way up and stops warning once the ceiling is hit", () => {
    const budgets = { ...NONE, sessionUsd: 10, warnAtFraction: 0.8 };
    expect(approaching(spend({ sessionUsd: 7.9 }), budgets)).toBeNull();
    expect(approaching(spend({ sessionUsd: 8 }), budgets)?.kind).toBe("session");
    // Past the real ceiling there is nothing to warn about: the stop already
    // happened, and a warning beside it would read as a second, softer problem.
    expect(approaching(spend({ sessionUsd: 10 }), budgets)).toBeNull();
  });

  it("is off when the fraction is not a usable one", () => {
    for (const warnAtFraction of [0, 1, 1.5, -0.2]) {
      expect(approaching(spend({ sessionUsd: 9.9 }), { ...NONE, sessionUsd: 10, warnAtFraction })).toBeNull();
    }
  });
});

describe("what the user is told", () => {
  const hit = { kind: "session" as const, spent: 5.5, limit: 5 };

  // There used to be a second audience: `stopReason`, written for the model as
  // the denied tool call's result, phrased to forbid a retry. Both the denial
  // and the audience are gone - Sway no longer refuses tool calls, so nothing
  // carries a reason to the model, and its assertions were removed with it
  // rather than left asserting the phrasing of a string nobody reads.

  // The user is the only one who can act on this, and the only one told.
  it("tells the user what to do about it", () => {
    expect(stopNotice(hit)).toMatch(/raise the limit/i);
    expect(stopNotice(hit)).toMatch(/settings/i);
    expect(stopNotice(hit)).toMatch(/\$5\.00/);
  });

  // The stop announces itself once; this answers "why did nothing happen when I
  // pressed send", which is a different moment and a different sentence.
  it("says a message was held rather than sent, and where to unblock it", () => {
    expect(heldNotice(hit)).toMatch(/waiting/i);
    expect(heldNotice(hit)).toMatch(/raise the limit/i);
    expect(heldNotice(hit)).toMatch(/settings/i);
    expect(heldNotice(hit)).not.toEqual(stopNotice(hit));
  });

  it("reports context in percent and money in dollars", () => {
    expect(stopNotice({ kind: "context", spent: 92, limit: 90 })).toMatch(/90%/);
    expect(warnNotice({ kind: "session", spent: 4, limit: 5 }, { ...NONE, sessionUsd: 5 })).toMatch(/\$4\.00/);
  });
});
