import { describe, it, expect } from "vitest";
import { computeSessionDot, dotCertainty, type SessionDot, type SessionDotInputs } from "./sessionDot";
import { dotFromStatus, statusFromDot, statusPresentation, STATUS_LABEL, type SessionStatus } from "./sessionStatus";

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

  // The invariant Phase 11's revert-guard fix turned on, kept pinned but now
  // scoped to what it was ever true of: the *inferred* tiers, which is all this
  // matrix builds. A chat session with no live terminal tab does report
  // `executing` (see the chat-tier block below), which is precisely why
  // `revertBlockers` no longer pairs `executing` with `hasLiveTab`.
  it("never reports executing for an inferred session with no live tab", () => {
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
    // A question the agent asked raises it too: the turn is just as parked,
    // and it is the case that had no notification behind it at all.
    expect(dotFromStatus("waitingForAnswer")).toBe("needsYou");
    // A budget stop raises the same needs-you edge as a permission prompt.
    // Both mean "this is not going anywhere until you look at it", which is the
    // only question the dot answers - and a stopped chat reported as idle would
    // sit there unnoticed until someone wondered why it never finished.
    expect(dotFromStatus("budgetStopped")).toBe("needsYou");
  });

  // `liveCounts` counts any dot other than "none" as a running session, so an
  // ended chat must not keep a tray entry alive.
  it("maps an ended chat onto no dot at all", () => {
    expect(dotFromStatus("none")).toBe("none");
  });
});

// The tier Phase 11 added, ahead of both inferred branches.
describe("the chat tier", () => {
  const statuses: SessionStatus[] = ["executing", "waitingForApproval", "idle", "running", "none"];

  // The whole point of putting it first: a chat has no PTY to watch and its
  // pgrep probe is beside the point, so every combination of the inferred
  // inputs has to leave the answer alone.
  it("wins over every combination of the inferred inputs", () => {
    for (const chatStatus of statuses) {
      for (const hasLiveTab of [true, false]) {
        for (const running of [true, false]) {
          for (const ptyActivity of [undefined, "active", "quiet"]) {
            for (const tailState of [undefined, "blocked-candidate", "streaming"]) {
              const inputs: SessionDotInputs = { chatStatus, hasLiveTab, running, ptyActivity, tailState };
              expect(computeSessionDot(inputs)).toBe(dotFromStatus(chatStatus));
              expect(statusFromDot(computeSessionDot(inputs))).toBe(chatStatus);
            }
          }
        }
      }
    }
  });

  // The case the golden matrix cannot contain and the revert guard turns on: a
  // chat mid-turn is `executing` with no terminal tab anywhere near it.
  it("reports executing for a chat with no live terminal tab", () => {
    const dot = computeSessionDot({ chatStatus: "executing", hasLiveTab: false, running: false });
    expect(statusFromDot(dot)).toBe("executing");
  });

  it("is inert when no chat hosts the session", () => {
    const inferred: SessionDotInputs = { hasLiveTab: true, running: true, ptyActivity: "active" };
    expect(computeSessionDot(inferred)).toBe("working");
    expect(computeSessionDot({ ...inferred, chatStatus: undefined })).toBe("working");
  });
});

// Certainty is what the sidebar marks, and it is derived from the same inputs
// rather than returned beside the dot - so recording it could not move the
// golden fixture's shape even by accident.
describe("dotCertainty", () => {
  it("calls a chat-backed session exact and everything else inferred", () => {
    expect(dotCertainty({ chatStatus: "idle", hasLiveTab: false, running: false })).toBe("exact");
    expect(dotCertainty({ hasLiveTab: true, running: true, ptyActivity: "active" })).toBe("inferred");
    expect(dotCertainty({ hasLiveTab: false, running: true })).toBe("inferred");
  });

  // An ended chat is still a chat: Sway measured that it ended rather than
  // failing to find it. Downgrading it to inferred would claim less than it
  // knows, which is the mirror image of the mistake the tiering prevents.
  it("keeps an ended chat on the exact side", () => {
    expect(dotCertainty({ chatStatus: "none", hasLiveTab: false, running: false })).toBe("exact");
  });
});

// How the tiering reaches the screen. The rule under test is which side gets
// marked, because getting it backwards is what would have restyled every
// pre-chat session.
describe("statusPresentation", () => {
  const detectable = ["executing", "waitingForApproval", "idle", "running"] as const;

  // The verify: a chat and an external session in the same state must not be
  // one indistinguishable row. The class flag is what the sidebar hangs the
  // marker rule on and the title is what a hover reads.
  it("tells the two tiers apart in the same status", () => {
    for (const status of detectable) {
      const exact = statusPresentation(status, "exact");
      const inferred = statusPresentation(status, "inferred");
      expect(exact.exact).toBe(true);
      expect(inferred.exact).toBe(false);
      expect(exact.title).not.toBe(inferred.title);
    }
  });

  // The other half, and the one that keeps the golden fixture passing
  // unmodified: the inferred side is byte-for-byte what it has always been.
  it("leaves the inferred side exactly as it was", () => {
    for (const status of detectable) {
      expect(statusPresentation(status, "inferred")).toEqual({ title: STATUS_LABEL[status], exact: false });
    }
  });

  it("marks the exact side by adding to the label rather than qualifying the other", () => {
    for (const status of detectable) {
      expect(statusPresentation(status, "exact").title.startsWith(STATUS_LABEL[status])).toBe(true);
    }
  });
});
