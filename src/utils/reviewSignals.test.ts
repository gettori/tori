import { describe, it, expect } from "vite-plus/test";
import { signalLabel } from "./reviewSignals";

describe("the radar's two Inbox signals", () => {
  it("say how many files would conflict with the base", () => {
    expect(signalLabel({ kind: "baseConflict", count: 1, points: 20 })).toBe("1 file would conflict with the base");
    expect(signalLabel({ kind: "baseConflict", count: 3, points: 20 })).toBe("3 files would conflict with the base");
  });

  it("say how many files another worktree is changing too", () => {
    expect(signalLabel({ kind: "worktreeOverlap", count: 2, points: 15 })).toBe(
      "2 files also being changed in another worktree",
    );
  });
});
