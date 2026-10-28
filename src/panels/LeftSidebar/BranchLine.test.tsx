import { describe, it, expect } from "vite-plus/test";
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
    stack: null,
    ...over,
  },
  checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
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

  it("shows a stacked pull request's layer and leaves a plain one unmarked", () => {
    const { container, unmount } = render(() => (
      <BranchLine status={status({ stack: { number: 9, size: 3, position: 2, baseRef: "main" } })} />
    ));
    expect(container.querySelector("[data-pr-stack]")?.textContent).toBe("2/3");
    unmount();

    const plain = render(() => <BranchLine status={status({})} />);
    expect(plain.container.querySelector("[data-pr-stack]")).toBeNull();
  });
});

describe("what a branch has cost", () => {
  it("adds the dollars to a pull request's line", () => {
    const { container } = render(() => (
      <BranchLine status={status({})} branchSpend={{ tokens: 9, costUsd: 3.5, turns: 2 }} />
    ));
    expect(container.querySelector("[data-spend]")?.textContent).toBe("$3.50");
  });

  it("draws the line for spend alone, in turns for an agent with no cost", () => {
    const { container } = render(() => (
      <BranchLine status={null} branchSpend={{ tokens: 0, costUsd: null, turns: 7 }} />
    ));
    expect(container.querySelector("[data-spend]")?.textContent).toBe("7 turns");
  });

  it("stays absent when there is no pull request, no diff and nothing spent", () => {
    const { container } = render(() => (
      <BranchLine status={null} branchSpend={{ tokens: 0, costUsd: null, turns: 0 }} />
    ));
    expect(container.firstChild).toBeNull();
  });
});
