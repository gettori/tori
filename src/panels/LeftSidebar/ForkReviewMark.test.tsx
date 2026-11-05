import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { worktreePath: string }) =>
    Promise.resolve(cmd === "worktree_fork_marked" && args.worktreePath === "/p/pr-7"),
  ),
}));

import ForkReviewMark from "./ForkReviewMark";

describe("ForkReviewMark", () => {
  it("marks a fork's review worktree and leaves the project's own alone", async () => {
    render(() => (
      <>
        <ForkReviewMark folder="/p/pr-7" />
        <ForkReviewMark folder="/p/feat" />
      </>
    ));
    expect(await screen.findAllByLabelText("Fork review, project code off")).toHaveLength(1);
  });
});
