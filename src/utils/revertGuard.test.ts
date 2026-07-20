import { describe, it, expect } from "vitest";
import { revertGuard, revertBlockers, type RevertCandidate } from "./revertGuard";

const REPO = "/work/repo";

function candidate(over: Partial<RevertCandidate> & { sessionId: string }): RevertCandidate {
  return {
    sessionName: over.sessionId,
    folderPath: REPO,
    status: "idle",
    hasLiveTab: true,
    ...over,
  };
}

describe("revertGuard", () => {
  it("allows a revert when every folder-local session is idle", () => {
    const verdict = revertGuard([candidate({ sessionId: "a" }), candidate({ sessionId: "b" })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("refuses hard, naming the session, while a live tab is Executing", () => {
    const verdict = revertGuard(
      [candidate({ sessionId: "a" }), candidate({ sessionId: "busy", status: "executing" })],
      { folderPath: REPO },
    );
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(false);
    expect(verdict.reason).toContain("busy");
    expect(verdict.blockers).toEqual([{ sessionId: "busy", sessionName: "busy", kind: "executing" }]);
  });

  it("does not let the detached override unblock a verified Executing session", () => {
    const verdict = revertGuard([candidate({ sessionId: "busy", status: "executing" })], {
      folderPath: REPO,
      allowDetached: true,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.overridable).toBe(false);
  });

  it("refuses a detached running session by default, but names it as overridable", () => {
    const verdict = revertGuard([candidate({ sessionId: "ghost", status: "running", hasLiveTab: false })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.overridable).toBe(true);
    expect(verdict.reason).toContain("ghost");
    expect(verdict.blockers[0].kind).toBe("detached");
  });

  it("proceeds past a detached session only once the override is invoked", () => {
    const sessions = [candidate({ sessionId: "ghost", status: "running", hasLiveTab: false })];
    expect(revertGuard(sessions, { folderPath: REPO }).allow).toBe(false);
    const overridden = revertGuard(sessions, {
      folderPath: REPO,
      allowDetached: true,
    });
    expect(overridden.allow).toBe(true);
    // The blast radius is still reported, so the confirm can list it.
    expect(overridden.blockers[0].sessionName).toBe("ghost");
  });

  it("counts a session in a subfolder, and ignores one outside the repo", () => {
    const blockers = revertBlockers(
      [
        candidate({
          sessionId: "nested",
          folderPath: `${REPO}/packages/app`,
          status: "executing",
        }),
        candidate({
          sessionId: "elsewhere",
          folderPath: "/work/other",
          status: "executing",
        }),
      ],
      REPO,
    );
    expect(blockers.map((b) => b.sessionId)).toEqual(["nested"]);
  });

  it("names several blockers readably", () => {
    const verdict = revertGuard(
      [candidate({ sessionId: "one", status: "executing" }), candidate({ sessionId: "two", status: "executing" })],
      { folderPath: REPO },
    );
    if (verdict.allow) throw new Error("expected a block");
    expect(verdict.reason).toContain("one and two");
    expect(verdict.reason).toContain("are running");
  });

  it("treats a live tab that is merely running as no blocker", () => {
    // "running" on a live tab is the idle-but-alive case; only the detached
    // tier's unverifiable "running" blocks.
    const verdict = revertGuard([candidate({ sessionId: "alive", status: "running" })], {
      folderPath: REPO,
    });
    expect(verdict.allow).toBe(true);
  });
});
