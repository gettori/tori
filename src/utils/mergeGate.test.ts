import { describe, it, expect } from "vitest";
import { mergeGate } from "./mergeGate";
import { MERGEABLE_STATES, type MergeableState } from "./forgeTypes";

describe("what a mergeability verdict permits", () => {
  it("covers every state the server can send", () => {
    // A state with no entry would fall through to `unknown`, which reads as a
    // sentence nobody wrote for it. The compiler catches a *new* variant; this
    // catches one that was added to the union and forgotten here.
    const summaries = MERGEABLE_STATES.map((s) => mergeGate(s).summary);
    for (const s of summaries) expect(s).toBeTruthy();
    expect(new Set(summaries).size, "two states share one sentence").toBe(summaries.length);
  });

  it("lets a clean pull request merge with nobody having approved it", () => {
    // The whole reason the gate reads `mergeableState` and not `reviewDecision`.
    // On a single-owner repo the author cannot approve their own pull request,
    // so a review-derived gate would block every merge Sway ever offers, and the
    // server would have been happy to take all of them.
    expect(mergeGate("clean").block).toBe(false);
  });

  it("blocks on the server's verdict, not on failing checks it does not require", () => {
    // `unstable` is mergeable to GitHub: the checks that are red are not
    // required. Blocking it here would be this app overruling the server in the
    // direction that merely *looks* careful.
    expect(mergeGate("unstable").block).toBe(false);
    expect(mergeGate("unstable").summary).toContain("none that this repo requires");

    // `blocked` is the opposite: the server says no, and no local reading of the
    // checks can talk it round.
    expect(mergeGate("blocked").block).toBe(true);
  });

  it("never guesses which rule is blocking", () => {
    // The specifics live in a branch-protection rule this app cannot read.
    // "Needs one approval" would be a sentence Sway invented; the server's own
    // wording arrives with the refusal, and that is where it belongs.
    expect(mergeGate("blocked").summary).not.toMatch(/approv|review|check/i);
  });

  it("offers an update only to a branch that is merely behind", () => {
    // A conflicted branch is the sharp one: update-branch is itself a merge, so
    // offering it there is offering a button that cannot work.
    const updatable = MERGEABLE_STATES.filter((s) => mergeGate(s).canUpdate);
    expect(updatable).toEqual(["behind"]);
  });

  it("treats a state it has never seen as ask-again, not as permission", () => {
    expect(mergeGate("something_new" as MergeableState).block).toBe(true);
    expect(mergeGate("unknown").block).toBe(true);
  });
});
