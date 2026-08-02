import { describe, it, expect } from "vitest";
import { computeSessionDot, type SessionDot, type SessionDotInputs } from "./sessionDot";
import { statusFromDot, type SessionStatus } from "./sessionStatus";

// The CI cases, in their own fixture.
//
// `sessionDot.golden.json` is a frozen record of how the inferred tiers behaved
// before chat existed, and its whole value is that it has never moved. Letting
// it absorb these rows would mean one `npx vitest -u` rewrites the baseline it
// was created to protect - so this is a second file, and the first one has to
// keep passing unmodified alongside it.
//
// Regenerate deliberately, never reflexively:
//   npx vitest run src/utils/sessionDotCi.test.ts -u
// A diff here means a failing check now reaches a different set of sessions,
// which is a change to who gets interrupted.

const HAS_LIVE_TAB = [true, false];
const RUNNING = [true, false];
const PTY_ACTIVITY: (SessionDotInputs["ptyActivity"] | undefined)[] = [undefined, "active", "quiet"];
const TAIL_STATE: (string | undefined)[] = [undefined, "blocked-candidate"];
const CHAT_STATUS: (SessionStatus | undefined)[] = [
  undefined,
  "executing",
  "waitingForApproval",
  "idle",
  "running",
  "none",
];

type Row = {
  inputs: SessionDotInputs;
  /** What the session would have been with no forge answer at all. */
  without: SessionDot;
  /** And with a failing check on the branch it owns. */
  with: SessionDot;
  status: SessionStatus;
};

function buildMatrix(): Row[] {
  const rows: Row[] = [];
  for (const chatStatus of CHAT_STATUS) {
    for (const hasLiveTab of HAS_LIVE_TAB) {
      for (const running of RUNNING) {
        for (const ptyActivity of PTY_ACTIVITY) {
          for (const tailState of TAIL_STATE) {
            const base: SessionDotInputs = { chatStatus, hasLiveTab, running, ptyActivity, tailState };
            const withCi = computeSessionDot({ ...base, forgeAttention: true });
            rows.push({
              inputs: { ...base, forgeAttention: true },
              without: computeSessionDot(base),
              with: withCi,
              status: statusFromDot(withCi),
            });
          }
        }
      }
    }
  }
  return rows;
}

describe("a failing check on the branch a session owns", () => {
  const rows = buildMatrix();

  it("reproduces the committed golden exactly", async () => {
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/sessionDotCi.golden.json",
    );
  });

  it("changes nothing at all when the forge has not answered", () => {
    // The half that keeps the original fixture honest: with the field absent,
    // every one of these inputs has to produce what it always did.
    for (const r of rows) {
      const { forgeAttention: _, ...bare } = r.inputs;
      expect(computeSessionDot(bare)).toBe(r.without);
    }
  });

  it("raises a session that is sitting still, in either inferred tier", () => {
    // The task's two cases by name: a live PTY agent that is quiet, and a
    // detached session with no tab at all. Neither has a `chatStatus`, which is
    // what makes this a claim about the inferred tiers rather than about the
    // chat branch dressed up as one.
    const ptyIdle = { hasLiveTab: true, running: true, ptyActivity: "quiet" as const };
    expect(computeSessionDot(ptyIdle)).toBe("solid");
    expect(computeSessionDot({ ...ptyIdle, forgeAttention: true })).toBe("needsYou");

    const detached = { hasLiveTab: false, running: true };
    expect(computeSessionDot(detached)).toBe("hollow");
    expect(computeSessionDot({ ...detached, forgeAttention: true })).toBe("needsYou");
  });

  it("leaves a session that is actively working alone", () => {
    // An agent mid-turn may well be fixing the very thing that went red, and a
    // needs-you spent while it works cannot re-arm when it stops - so the one
    // edge that matters would be spent at the moment it mattered least.
    for (const r of rows) {
      if (r.without !== "working") continue;
      expect(r.with).toBe("working");
    }
    expect(rows.some((r) => r.without === "working")).toBe(true);
  });

  it("does not start ringing for a session that is not running", () => {
    // A tab whose process exited still sits in the tree. Raising it would put a
    // permanent warning on a dead session for as long as CI stays red, and it
    // would never clear by anything the user does to that session.
    for (const r of rows) {
      if (r.without !== "none") continue;
      expect(r.with).toBe("none");
    }
    expect(rows.some((r) => r.without === "none")).toBe(true);
  });

  it("never lowers a dot", () => {
    // The rule is a raise. A branch going red must not be able to take a
    // session *out* of needs-you, which is the one way a real prompt could be
    // hidden by a CI failure.
    for (const r of rows) {
      if (r.without === "needsYou") expect(r.with).toBe("needsYou");
    }
  });

  it("applies to a chat sitting idle exactly as it does to a PTY agent", () => {
    // No special case for the chat tier: the raise is applied to whatever the
    // tiers decided, so an idle chat is `solid` and rises, a mid-turn one is
    // `working` and does not.
    expect(computeSessionDot({ chatStatus: "idle", hasLiveTab: false, running: false })).toBe("solid");
    expect(
      computeSessionDot({ chatStatus: "idle", hasLiveTab: false, running: false, forgeAttention: true }),
    ).toBe("needsYou");
    expect(
      computeSessionDot({ chatStatus: "executing", hasLiveTab: false, running: false, forgeAttention: true }),
    ).toBe("working");
  });
});
