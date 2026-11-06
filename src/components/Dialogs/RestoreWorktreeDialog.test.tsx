import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import RestoreWorktreeDialog, { type Rescued } from "./RestoreWorktreeDialog";

const now = Date.now();

const rebased: Rescued = {
  id: `${now - 2 * 3600_000}-aaaa1111`,
  branch: "feat-login",
  worktree: "/c/feat-login",
  deletedAt: now - 2 * 3600_000,
  operation: "rebase 3/7",
  files: ["a.txt", "new.txt"],
  commits: ["Add the login form", "Wire the session"],
  skipped: ["dump.bin"],
};

const older: Rescued = {
  id: `${now - 3 * 86400_000}-bbbb2222`,
  branch: "fix-typo",
  worktree: "/c/fix-typo",
  deletedAt: now - 3 * 86400_000,
  operation: null,
  files: [],
  commits: [],
  skipped: [],
};

function open(rescues: Rescued[] | null = [rebased, older]) {
  const onRestore = vi.fn();
  render(() => (
    <RestoreWorktreeDialog projectName="web" rescues={rescues} busy={false} onRestore={onRestore} onCancel={() => {}} />
  ));
  return { onRestore };
}

const detail = () => document.querySelector("[data-restore-detail]")!.textContent ?? "";

describe("restoring a deleted worktree", () => {
  it("lists each copy with its branch, its age and the operation it was in", () => {
    open();
    expect(screen.getByText("feat-login")).toBeTruthy();
    expect(screen.getByText("fix-typo")).toBeTruthy();
    expect(screen.getByText("rebase 3/7")).toBeTruthy();
    expect([...document.querySelectorAll("[data-restore-age]")].map((e) => e.textContent)).toEqual([
      "2h ago",
      "3d ago",
    ]);
  });

  it("says what comes back for the newest copy and restores it", () => {
    const { onRestore } = open();
    expect(detail()).toContain("Deleted in the middle of a rebase, at 3/7");
    expect(detail()).toContain("2 changed files: a.txt, new.txt");
    expect(detail()).toContain("2 commits no branch holds");
    expect(detail()).toContain("Add the login form");
    expect(detail()).toContain("too large: dump.bin");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(rebased.id);
  });

  it("restores the copy that was picked", () => {
    const { onRestore } = open();
    fireEvent.click(screen.getByText("fix-typo"));
    expect(detail()).toContain("No changed files");
    expect(detail()).not.toContain("commit");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(older.id);
  });

  it("offers nothing to restore while the list is still loading", () => {
    open(null);
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
