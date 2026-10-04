import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import BranchLine from "./BranchLine";
import type { PullRequest, UnitStatus } from "../../utils/forgeTypes";

const HOUR = 3600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const status = (over: Partial<PullRequest>): UnitStatus => ({
  headRef: "wave-3",
  pullRequest: {
    number: 12,
    title: "Let a branch wear its pull request",
    body: null,
    state: "open",
    isDraft: false,
    createdAt: iso(72),
    mergedAt: null,
    closedAt: null,
    comments: 0,
    author: "skarif2",
    headRef: "wave-3",
    baseRef: "main",
    headSha: "abc123",
    headRepoIsOrigin: true,
    url: "https://github.com/skarif2/tori/pull/12",
    mergeableState: "clean",
    ...over,
  },
  checks: { state: "none", total: 0, failing: 0, contexts: [] },
  reviewDecision: "none",
});

describe("a pull request's line", () => {
  it("dates an open pull request by when it opened", () => {
    render(() => <BranchLine status={status({})} />);
    expect(screen.getByText("3d")).toBeTruthy();
  });

  it("dates a merged or closed one by when it finished", () => {
    render(() => <BranchLine status={status({ state: "merged", mergedAt: iso(2), closedAt: iso(2) })} />);
    expect(screen.getByText("merged 2h")).toBeTruthy();
    expect(screen.queryByText("3d")).toBeNull();
  });

  it("says closed for one that closed without merging", () => {
    render(() => <BranchLine status={status({ state: "closed", closedAt: iso(5) })} />);
    expect(screen.getByText("closed 5h")).toBeTruthy();
  });
});
