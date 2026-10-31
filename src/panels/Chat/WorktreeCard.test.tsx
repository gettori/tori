import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, fireEvent } from "@solidjs/testing-library";
import WorktreeCard from "./WorktreeCard";
import type { ToolItem } from "./chatStore";
import { noteForgeUnits, resetSessionActivityForTests, type ForgeUnit } from "../../utils/sessionActivity";
import { cardProjects } from "../../utils/forgeStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

function card(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    turnId: "t1",
    toolUseId: "toolu_1",
    agentId: null,
    name: "mcp__tori__worktree_new",
    title: null,
    toolKind: "other",
    locations: [],
    input: { branch: "fix-a" },
    output: JSON.stringify({ path: "/p/fix-a", made_by: "s1", setup: "none" }),
    outputTruncated: false,
    summary: null,
    patch: [],
    state: "ok",
    durationMs: 900,
    approval: null,
    edits: [],
    secret: null,
    blindEdits: [],
    files: [],
    ...over,
  };
}

function unit(over: Partial<ForgeUnit> = {}): ForgeUnit {
  return {
    kind: "worktree",
    branch: "fix-a",
    isCurrent: false,
    folderPath: "/p/fix-a",
    projectPath: "/p",
    attention: false,
    ...over,
  };
}

const main = unit({ branch: "main", folderPath: "/p/main" });

beforeEach(() => resetSessionActivityForTests());

describe("WorktreeCard", () => {
  it("says it is making the worktree while the call runs", () => {
    const { container } = render(() => <WorktreeCard card={card({ state: "running", output: null })} cwd="/p/main" />);
    expect(container.textContent).toContain("Making worktree");
    expect(container.textContent).toContain("fix-a");
  });

  it("opens the worktree it made when there is somewhere to go", () => {
    noteForgeUnits([main, unit()]);
    const open = vi.fn();
    const { getByText } = render(() => <WorktreeCard card={card()} cwd="/p/main" onOpenWorktree={open} />);
    fireEvent.click(getByText("Open"));
    expect(open).toHaveBeenCalledWith("/p/fix-a");
  });

  it("offers no Open without a handler", () => {
    noteForgeUnits([main, unit()]);
    const { queryByText } = render(() => <WorktreeCard card={card()} cwd="/p/main" />);
    expect(queryByText("Open")).toBeNull();
  });

  it("shows the pull request once the forge has one", () => {
    noteForgeUnits([main, unit({ prKnown: true, pullRequest: { number: 42, state: "merged", title: "t" } })]);
    const { container } = render(() => <WorktreeCard card={card()} cwd="/p/main" />);
    expect(container.textContent).toContain("PR #42 merged");
  });

  it("says removed once the unit is gone while others are loaded", () => {
    noteForgeUnits([main]);
    const { container, queryByText } = render(() => (
      <WorktreeCard card={card()} cwd="/p/main" onOpenWorktree={() => {}} />
    ));
    expect(container.textContent).toContain("Removed");
    expect(queryByText("Open")).toBeNull();
  });

  it("claims nothing when no units are loaded at all", () => {
    const { container } = render(() => <WorktreeCard card={card()} cwd="/p/main" />);
    expect(container.textContent).not.toContain("Removed");
    expect(container.textContent).not.toContain("PR #");
  });

  it("watches its branch with the forge while mounted", () => {
    noteForgeUnits([main, unit()]);
    const { unmount } = render(() => <WorktreeCard card={card()} cwd="/p/main" />);
    expect(cardProjects()).toEqual([{ path: "/p", units: [{ branch: "fix-a", visible: true }] }]);
    unmount();
    expect(cardProjects()).toEqual([]);
  });
});
