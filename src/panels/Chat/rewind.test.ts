import { describe, expect, it } from "vitest";
import { REWIND_BANNER, REWIND_CAVEAT, rewindSeed } from "./rewind";

// A rewind's one leak is that the forked agent still remembers the turns being
// undone. These assert that each of the three places the user could learn that
// actually says it, because the mechanism was chosen *with* that cost: copy
// that quietly drops it turns a stated trade-off into a silent one.
describe("what a rewind admits to", () => {
  it("warns before anything is written that the memory does not go back", () => {
    expect(REWIND_CAVEAT).toMatch(/remember/i);
  });

  it("keeps saying it on the rewound tab, not just once at the confirm", () => {
    expect(REWIND_BANNER).toMatch(/remember/i);
  });

  it("tells the agent itself, and asks for the re-read rather than implying it", () => {
    const seed = rewindSeed();
    expect(seed).toMatch(/gone from disk/i);
    // Spike 2: a reason naming its own fix produced the retry 9 times in 9 but
    // the re-read only 7, so "the files changed" cannot be left to imply "look
    // again".
    expect(seed).toMatch(/read a file before you change it/i);
  });

  it("leaves the user room to type after it, since it is a draft and not the turn", () => {
    expect(rewindSeed()).toMatch(/\n$/);
  });
});
