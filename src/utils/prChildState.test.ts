import { describe, it, expect } from "vite-plus/test";
import { prChildState } from "./prChildState";
import type { LatestReview, PullRequest, UnitStatus } from "./forgeTypes";

const ME = "skarif2";

const unit = (pr: Partial<PullRequest> | null, over: Partial<UnitStatus> = {}): UnitStatus => ({
  headRef: "wave-3",
  pullRequest:
    pr === null ? null : ({ number: 12, state: "open", isDraft: false, author: ME, comments: 0, ...pr } as PullRequest),
  checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
  reviewDecision: "none",
  reviews: [],
  requestedReviewers: [],
  viewerReview: null,
  ...over,
});
const review = (author: string, verdict: LatestReview["verdict"]): LatestReview => ({ author, verdict });

describe("prChildState", () => {
  it.each([
    ["no PR", unit(null), false, "noPr"],
    ["draft", unit({ isDraft: true }), false, "draft"],
    ["ready", unit({}), false, "ready"],
    ["commented", unit({}, { reviews: [review("ana", "commented")] }), false, "commented"],
    [
      "changes requested",
      unit({}, { reviewDecision: "changesRequested", reviews: [review("ana", "changesRequested")] }),
      false,
      "changesRequested",
    ],
    [
      "changes requested on a repo with no review rule",
      unit({}, { reviews: [review("ana", "changesRequested")] }),
      false,
      "changesRequested",
    ],
    [
      "re-review requested",
      unit({}, { reviews: [review("ana", "changesRequested")], requestedReviewers: ["ana"] }),
      false,
      "reReview",
    ],
    ["approved", unit({}, { reviewDecision: "approved" }), false, "approved"],
    ["approved with no review rule", unit({}, { reviews: [review("ana", "approved")] }), false, "approved"],
    ["merged", unit({ state: "merged" }), false, "merged"],
    ["closed", unit({ state: "closed" }), false, "closed"],
    ["review requested of you", unit({ author: "ana" }), true, "reviewRequested"],
    ["reviewed by you", unit({ author: "ana" }, { viewerReview: "approved" }), false, "reviewed"],
    [
      "reviewed by you, read off the list",
      unit({ author: "ana" }, { reviews: [review(ME, "commented")] }),
      false,
      "reviewed",
    ],
    [
      "a merged PR you reviewed",
      unit({ author: "ana", state: "merged" }, { viewerReview: "commented" }),
      false,
      "merged",
    ],
  ] as const)("%s", (_, status, asked, want) => {
    expect(prChildState(status, ME, asked)).toBe(want);
  });

  it("keeps your own PR Ready when only you have commented", () => {
    expect(prChildState(unit({}, { reviews: [review(ME, "commented")] }), ME, false)).toBe("ready");
  });

  it("does not read a second pending reviewer as a re-review", () => {
    const s = unit({}, { reviews: [review("ana", "changesRequested")], requestedReviewers: ["bo"] });
    expect(prChildState(s, ME, false)).toBe("changesRequested");
  });

  it("leaves a colleague's PR you were never part of unlaned, open or finished", () => {
    expect(prChildState(unit({ author: "ana" }), ME, false)).toBe("unlaned");
    expect(prChildState(unit({ author: "ana", state: "merged" }), ME, false)).toBe("unlaned");
    expect(prChildState(unit({ author: "ana", state: "closed" }), ME, false)).toBe("unlaned");
  });

  it("never reads Changes requested off a GitLab merge request", () => {
    // GitLab's only verdict is an approval, and its reviewers stay listed.
    const s = unit({}, { reviewDecision: "reviewRequired", requestedReviewers: ["ana"] });
    expect(prChildState(s, ME, false)).toBe("ready");
    const approved = unit({}, { reviewDecision: "approved", reviews: [review("ana", "approved")] });
    expect(prChildState(approved, ME, false)).toBe("approved");
  });
});
