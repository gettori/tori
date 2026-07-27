import { describe, it, expect } from "vitest";
import { computeSessionDot, type SessionDot, type SessionDotInputs } from "./sessionDot";
import { dotFromStatus, statusFromDot, type SessionStatus } from "./sessionStatus";

// A golden baseline of today's status behaviour, captured *before* chat exists.
//
// Phase 11 adds a chat status tier ahead of the existing branches and promises
// the PTY-agent and external-session paths keep rendering exactly as they do
// now. This file is what makes that promise checkable rather than asserted: it
// enumerates the full input matrix, records every dot and its mapped status,
// and fails if any of it moves. When Phase 11 lands, this test passing
// unchanged is the evidence that only the new tier changed.
//
// Regenerate deliberately, never reflexively:
//   npx vitest run src/utils/sessionDot.test.ts -u
// A diff here means the inferred-status rendering changed, which is precisely
// the thing Phase 11 said it would not do.
//
// The comparison uses vitest's file snapshot rather than reading the fixture
// with `node:fs`: this project ships no `@types/node`, so a test importing node
// builtins typechecks locally and breaks `tsc --noEmit` for everyone.

const HAS_LIVE_TAB = [true, false];
const RUNNING = [true, false];
// `undefined` is the real fourth state of the activity map, not padding: a tab
// with no recorded activity yet reads as absent, and it must not be mistaken
// for quiet.
const PTY_ACTIVITY: (SessionDotInputs["ptyActivity"] | undefined)[] = [undefined, "active", "quiet"];
const TAIL_STATE: (string | undefined)[] = [undefined, "blocked-candidate", "streaming"];

type Row = {
  /** Which of the three worlds this row describes, named for readability. */
  case: "agent-tab" | "external-session" | "no-session";
  inputs: SessionDotInputs;
  dot: SessionDot;
  status: SessionStatus;
};

function caseName(hasLiveTab: boolean, running: boolean): Row["case"] {
  if (hasLiveTab) return "agent-tab";
  return running ? "external-session" : "no-session";
}

function buildMatrix(): Row[] {
  const rows: Row[] = [];
  for (const hasLiveTab of HAS_LIVE_TAB) {
    for (const running of RUNNING) {
      for (const ptyActivity of PTY_ACTIVITY) {
        for (const tailState of TAIL_STATE) {
          const inputs: SessionDotInputs = { hasLiveTab, running, ptyActivity, tailState };
          const dot = computeSessionDot(inputs);
          rows.push({ case: caseName(hasLiveTab, running), inputs, dot, status: statusFromDot(dot) });
        }
      }
    }
  }
  return rows;
}

describe("sessionDot golden baseline", () => {
  const rows = buildMatrix();

  it("reproduces the committed golden exactly", async () => {
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/sessionDot.golden.json",
    );
  });

  it("covers all three worlds the status machinery has to serve", () => {
    const cases = new Set(rows.map((r) => r.case));
    expect([...cases].sort()).toEqual(["agent-tab", "external-session", "no-session"]);
  });

  // The load-bearing invariant Phase 11's revert-guard fix turns on, pinned
  // here so it is impossible to break it silently: today, a session with no
  // live tab can never report `executing`. `revertBlockers` relies on exactly
  // that to split its two branches, and a chat session is what will break it.
  it("never reports executing for a session with no live tab", () => {
    const detached = rows.filter((r) => !r.inputs.hasLiveTab);
    expect(detached.length).toBeGreaterThan(0);
    for (const r of detached) {
      expect(r.status).not.toBe("executing");
    }
  });

  it("caps a detached session at the hollow running dot", () => {
    for (const r of rows.filter((r) => r.case === "external-session")) {
      expect(r.dot).toBe("hollow");
    }
    for (const r of rows.filter((r) => r.case === "no-session")) {
      expect(r.dot).toBe("none");
    }
  });

  // Needs-you needs both signals. Either alone is a guess, and a guess rendered
  // as certainty is what the evidence tiering exists to prevent.
  it("requires both a quiet pty and a blocked tail for needs-you", () => {
    for (const r of rows) {
      if (r.dot !== "needsYou") continue;
      expect(r.inputs.ptyActivity).toBe("quiet");
      expect(r.inputs.tailState).toBe("blocked-candidate");
    }
    expect(rows.some((r) => r.dot === "needsYou")).toBe(true);
  });
});

// The chat tier knows its status directly and has to hand it back into the
// dot-shaped presence pipeline (OS notification, tray, dock badge). If the two
// mappings ever disagreed there would be two answers to "is anything waiting on
// me", which is the one question presence exists to answer.
describe("dotFromStatus", () => {
  const statuses: SessionStatus[] = ["executing", "waitingForApproval", "idle", "running", "none"];

  it("round-trips every status through the dot vocabulary unchanged", () => {
    for (const status of statuses) {
      expect(statusFromDot(dotFromStatus(status))).toBe(status);
    }
  });

  // The one that carries the notification, the badge and the tab marker.
  it("maps a blocked chat onto the needs-you dot the notification path watches", () => {
    expect(dotFromStatus("waitingForApproval")).toBe("needsYou");
  });

  // `liveCounts` counts any dot other than "none" as a running session, so an
  // ended chat must not keep a tray entry alive.
  it("maps an ended chat onto no dot at all", () => {
    expect(dotFromStatus("none")).toBe("none");
  });
});
