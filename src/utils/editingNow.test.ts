import { describe, it, expect } from "vite-plus/test";
import { editingIndication, isSoleLiveActor } from "./editingNow";
import type { RevertCandidate } from "./revertGuard";

function candidate(over: Partial<RevertCandidate> = {}): RevertCandidate {
  return {
    sessionId: "s1",
    sessionName: "Session 1",
    folderPath: "/repo",
    status: "executing",
    hasLiveTab: true,
    ...over,
  };
}

describe("editingIndication", () => {
  it("shows nothing when the session is not executing", () => {
    // Not a turn in flight, so there is nothing to be editing - even though a
    // path is on hand from the last one.
    expect(
      editingIndication({
        executing: false,
        parserPath: "/repo/a.ts",
        fsPath: "/repo/a.ts",
        soleLiveActor: true,
      }),
    ).toBeNull();
  });

  it("names the parser's file regardless of who else is live", () => {
    // Direct attribution: the session's own transcript says it wrote this, so a
    // second agent in the folder does not weaken the claim.
    expect(
      editingIndication({
        executing: true,
        parserPath: "/repo/a.ts",
        fsPath: "/repo/other.ts",
        soleLiveActor: false,
      }),
    ).toEqual({ kind: "file", path: "/repo/a.ts" });
  });

  it("names an fs path only when the session is the sole live actor", () => {
    expect(editingIndication({ executing: true, fsPath: "/repo/b.ts", soleLiveActor: true })).toEqual({
      kind: "file",
      path: "/repo/b.ts",
    });
  });

  it("degrades to a file-less pulse when another actor could be the author", () => {
    // The watcher reports that a file changed, not who changed it. With a
    // second agent live here, naming the file would be a coin flip presented
    // as fact, so the indicator keeps the pulse and drops the name.
    expect(editingIndication({ executing: true, fsPath: "/repo/b.ts", soleLiveActor: false })).toEqual({
      kind: "anonymous",
    });
  });

  it("shows nothing while executing with no signal at all", () => {
    // "Executing" alone is already carried by the session dot; without a file
    // signal this would add noise, not information.
    expect(editingIndication({ executing: true, soleLiveActor: true })).toBeNull();
  });

  it("prefers the parser path over a conflicting fs path", () => {
    expect(
      editingIndication({
        executing: true,
        parserPath: "/repo/truth.ts",
        fsPath: "/repo/noise.ts",
        soleLiveActor: true,
      }),
    ).toEqual({ kind: "file", path: "/repo/truth.ts" });
  });
});

describe("isSoleLiveActor", () => {
  it("ignores the session itself when deciding", () => {
    // The selected session being mid-turn is the whole premise, so it must not
    // count itself out of sole authorship.
    expect(isSoleLiveActor([candidate({ sessionId: "self" })], "self", "/repo")).toBe(true);
  });

  it("is false when another executing session shares the folder", () => {
    const others = [candidate({ sessionId: "self" }), candidate({ sessionId: "other" })];
    expect(isSoleLiveActor(others, "self", "/repo")).toBe(false);
  });

  it("is false when a detached session shares the folder", () => {
    // Detached activity is unverifiable, which is exactly the case where a
    // confident filename would be a guess.
    const others = [
      candidate({ sessionId: "self" }),
      candidate({ sessionId: "ghost", status: "running", hasLiveTab: false }),
    ];
    expect(isSoleLiveActor(others, "self", "/repo")).toBe(false);
  });

  it("ignores idle sessions and sessions in other folders", () => {
    const others = [
      candidate({ sessionId: "self" }),
      candidate({ sessionId: "idle", status: "idle" }),
      candidate({ sessionId: "elsewhere", folderPath: "/other-repo" }),
    ];
    expect(isSoleLiveActor(others, "self", "/repo")).toBe(true);
  });

  it("treats an unknown actor set as not-sole, never as empty", () => {
    // The probe is in flight or failed. An empty set would read as "nobody else
    // is here" and hand an fs event a confident filename on no evidence, which
    // is the one outcome the indicator must never produce.
    expect(isSoleLiveActor(null, "self", "/repo")).toBe(false);
  });

  it("counts a session in a subfolder as an actor", () => {
    // Same prefix rule the revert guard uses: an agent in a project subfolder
    // writes into the same tree.
    const others = [candidate({ sessionId: "nested", folderPath: "/repo/packages/api" })];
    expect(isSoleLiveActor(others, "self", "/repo")).toBe(false);
  });
});
