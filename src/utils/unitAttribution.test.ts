import { describe, it, expect } from "vitest";
import { belongsToUnit, fallbackHome, plainUnitKey } from "./unitAttribution";

const worktree = (branch: string) => ({ kind: "worktree", branch, isCurrent: false });
const plain = (branch: string | null, isCurrent = false) => ({ kind: "plain", branch, isCurrent });

describe("belongsToUnit", () => {
  // A worktree owns its folder outright, so the question never arises: whatever
  // is anchored there is its, whatever branch the transcript happens to name.
  it("gives a worktree everything in its folder", () => {
    const u = worktree("feat");
    expect(belongsToUnit({ agent: "claude", branch: "main" }, u, [u])).toBe(true);
    expect(belongsToUnit({ agent: "claude", branch: null }, u, [u])).toBe(true);
  });

  // The hard case: siblings share one folder and differ only by recorded
  // branch, so without this rule both rows claim both sessions.
  it("splits a plain repo's siblings by recorded branch", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    expect(belongsToUnit({ agent: "claude", branch: "feat" }, feat, units)).toBe(true);
    expect(belongsToUnit({ agent: "claude", branch: "feat" }, main, units)).toBe(false);
    expect(belongsToUnit({ agent: "claude", branch: "main" }, main, units)).toBe(true);
    expect(belongsToUnit({ agent: "claude", branch: "main" }, feat, units)).toBe(false);
  });

  // The branch was deleted, or HEAD went detached: no visible unit matches. The
  // session re-homes onto the checkout rather than vanishing - history is never
  // dropped just because a branch was.
  it("re-homes an orphaned recorded branch onto the checkout", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    const orphan = { agent: "claude", branch: "deleted-branch" };
    expect(belongsToUnit(orphan, main, units)).toBe(true);
    expect(belongsToUnit(orphan, feat, units)).toBe(false);
  });

  // pi records no branch at all, and a claude session can record none either.
  // Their files are whatever the checkout currently is, so they park there too.
  it("parks a branchless session on the checkout", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    for (const s of [{ agent: "pi" }, { agent: "claude", branch: "" }, { agent: "claude" }]) {
      expect(belongsToUnit(s, main, units)).toBe(true);
      expect(belongsToUnit(s, feat, units)).toBe(false);
    }
  });

  // A pi session ignores its own recorded branch even when one would match,
  // because the branch is not what decides where its files are.
  it("keeps a pi session on the checkout even when its branch has a unit", () => {
    const main = plain("main", true);
    const feat = plain("feat");
    const units = [main, feat];
    expect(belongsToUnit({ agent: "pi", branch: "feat" }, feat, units)).toBe(false);
    expect(belongsToUnit({ agent: "pi", branch: "feat" }, main, units)).toBe(true);
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
