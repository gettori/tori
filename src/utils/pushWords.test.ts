import { describe, it, expect } from "vite-plus/test";
import { divergedTarget, divergedWords, duplicateWarning, pullRebaseWords, pullWords, pushWords } from "./pushWords";

const ab = (ahead: number, behind: number, extra: object = {}) => ({
  ahead,
  behind,
  has_upstream: true,
  sets_upstream: false,
  gone: false,
  upstream: "origin/feat",
  push_target: { ahead, behind, sha: "abc" },
  ...extra,
});

describe("duplicateWarning", () => {
  it("warns only when two or more go up and more than half are copies", () => {
    expect(duplicateWarning(1, 1, "main")).toBeNull();
    expect(duplicateWarning(2, 2, "main")).toBe(
      "2 of 2 commits are already on main under other hashes, a pull replayed main onto this branch.",
    );
    expect(duplicateWarning(3, 1, "main")).toBeNull();
    expect(duplicateWarning(4, 2, "main")).toBeNull();
    expect(duplicateWarning(23, 23, "main")).toContain("23 of 23 commits");
  });
});

describe("pullWords", () => {
  it("says what a pull will do, with the merge commit when there is one", () => {
    expect(pullWords(null)).toBe("This branch has no upstream to pull from");
    expect(pullWords(ab(1, 0))).toBe("Up to date with origin/feat");
    expect(pullWords(ab(0, 3))).toBe("Fast-forward to origin/feat, 3 commits");
    expect(pullWords(ab(1, 1))).toBe("Merge origin/feat into this branch, 1 commit, adds a merge commit");
    expect(pullWords(ab(1, 1), true)).toContain("Fast-forward only");
  });
});

describe("pullRebaseWords", () => {
  it("says whose commits get replayed on what", () => {
    expect(pullRebaseWords(ab(0, 2))).toBe("Fast-forward to origin/feat, 2 commits");
    expect(pullRebaseWords(ab(1, 23))).toBe("Replay your 1 commit on top of origin/feat, after its 23 commits");
  });
});

describe("pushWords", () => {
  it("counts against origin/<branch>, and refuses a diverged one", () => {
    expect(pushWords(ab(2, 0), "feat", false)).toBe("2 commits to origin/feat");
    expect(pushWords(ab(1, 1), "feat", false)).toBe("Diverged: pull with rebase, or force push");
    expect(pushWords(ab(1, 1, { push_target: null, sets_upstream: true }), "feat", false)).toBe(
      "Publish feat to origin, sets upstream",
    );
  });
});

describe("divergedTarget", () => {
  it("is the push target only when both sides moved and nothing was superseded", () => {
    expect(divergedTarget(ab(1, 1), false)).toEqual({ ahead: 1, behind: 1, sha: "abc" });
    expect(divergedTarget(ab(1, 1), true)).toBeNull();
    expect(divergedTarget(ab(1, 0), false)).toBeNull();
    expect(divergedTarget(ab(1, 1, { push_target: null }), false)).toBeNull();
  });
});

describe("divergedWords", () => {
  const target = { ahead: 1, behind: 2, sha: "abc" };

  it("names both causes, and the rewrite hint only against the push target", () => {
    const plain = divergedWords(target, "feat", false, "origin/feat");
    expect(plain).toContain("1 commit here, 2 commits on origin/feat.");
    expect(plain).toContain("If somebody else pushed, Pull (Rebase).");
    expect(plain).not.toContain("rewrite here.");
    expect(divergedWords(target, "feat", true, "origin/feat")).toContain("This looks like a rewrite here.");
    expect(divergedWords(target, "feat", true, "origin/main")).not.toContain("This looks like a rewrite here.");
  });
});
