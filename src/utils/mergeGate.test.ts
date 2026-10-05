import { describe, it, expect } from "vite-plus/test";
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
    // so a review-derived gate would block every merge Tori ever offers, and the
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
    // "Needs one approval" would be a sentence Tori invented; the server's own
    // wording arrives with the refusal, and that is where it belongs.
    expect(mergeGate("blocked").summary).not.toMatch(/approv|review|check/i);
  });

  it("offers an update to the two states where the base has moved on", () => {
    // Including the conflicted one, where it can fail: Tori does not resolve
    // conflicts, so the choice there is the server's refusal, which names what
    // is fighting, or a panel with nothing to press at all.
    const updatable = MERGEABLE_STATES.filter((s) => mergeGate(s).canUpdate);
    expect(updatable.sort()).toEqual(["behind", "dirty"]);
  });

  it("keeps the control shape down to four while every state keeps its words", () => {
    // The panel has one row of buttons, so seven verdicts have to collapse into
    // the four shapes it can draw. What must not collapse with them is the
    // sentence: `draft` and `unknown` both read `blocked` to the controls and
    // still say the one thing that would change each of them.
    expect(mergeGate("draft").condition).toBe("blocked");
    expect(mergeGate("unknown").condition).toBe("blocked");
    expect(mergeGate("draft").summary).not.toBe(mergeGate("unknown").summary);
    // And the only disabled one is the only one that cannot merge from here.
    const blocking = MERGEABLE_STATES.filter((s) => mergeGate(s).block);
    const shapes = new Set(blocking.map((s) => mergeGate(s).condition));
    expect([...shapes].sort()).toEqual(["behind", "blocked", "dirty"]);
  });

  it("treats a state it has never seen as ask-again, not as permission", () => {
    expect(mergeGate("something_new" as MergeableState).block).toBe(true);
    expect(mergeGate("unknown").block).toBe(true);
  });
});
