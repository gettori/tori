import { describe, it, expect } from "vitest";
import { belongsToUnit, fallbackHome, plainUnitKey } from "./unitAttribution";

const worktree = (branch: string) => ({ kind: "worktree", branch, isCurrent: false });
const plain = (branch: string | null, isCurrent = false) => ({ kind: "plain", branch, isCurrent });

describe("belongsToUnit", () => {
  // A worktree owns its folder outright, so the question never arises: whatever
  // is anchored there is its, whatever branch the transcript happens to name.
  it("gives a worktree everything in its folder", () => {
    const u = worktree("feat");
    expect(belongsToUnit({ branch: "main" }, u, [u])).toBe(true);
    expect(belongsToUnit({ branch: null }, u, [u])).toBe(true);
  });

  // The hard case: siblings share one folder and differ only by recorded
  // branch, so without this rule both rows claim both sessions.
  it("splits a plain repo's siblings by recorded branch", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    expect(belongsToUnit({ branch: "feat" }, feat, units)).toBe(true);
    expect(belongsToUnit({ branch: "feat" }, main, units)).toBe(false);
    expect(belongsToUnit({ branch: "main" }, main, units)).toBe(true);
    expect(belongsToUnit({ branch: "main" }, feat, units)).toBe(false);
  });

  // The branch was deleted, or HEAD went detached: no visible unit matches. The
  // session re-homes onto the checkout rather than vanishing - history is never
  // dropped just because a branch was.
  it("re-homes an orphaned recorded branch onto the checkout", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    const orphan = { branch: "deleted-branch" };
    expect(belongsToUnit(orphan, main, units)).toBe(true);
    expect(belongsToUnit(orphan, feat, units)).toBe(false);
  });

  // A session can record no branch at all: an older scan, one started outside a
  // repo, or an ACP session, whose listed row carries only sessionId/cwd/title/
  // updatedAt and so has no branch to record. Its files are whatever the
  // checkout currently is, so it parks there rather than borrowing a sibling's
  // branch. Every shape of "no branch" has to reach the same answer.
  it("parks a branchless session on the checkout", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    for (const s of [{}, { branch: "" }, { branch: null }]) {
      expect(belongsToUnit(s, main, units)).toBe(true);
      expect(belongsToUnit(s, feat, units)).toBe(false);
    }
  });
});

describe("fallbackHome", () => {
  it("prefers the checkout, then the branchless unit, then the first plain one", () => {
    expect(fallbackHome([plain("a"), plain("b", true)])?.branch).toBe("b");
    expect(fallbackHome([plain("a"), plain(null)])?.branch).toBe(null);
    expect(fallbackHome([plain("a"), plain("b")])?.branch).toBe("a");
    expect(fallbackHome([worktree("a")])).toBe(null);
  });

  // A detached or unborn HEAD has no branch to be named by, and `undefined`
  // from a plain lookup would collide with it.
  it("gives the branchless unit a key that no branch can collide with", () => {
    expect(plainUnitKey(plain(null))).not.toBe(plainUnitKey(plain("main")));
  });
});
