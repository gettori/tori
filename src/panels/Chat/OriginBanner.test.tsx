import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render } from "@solidjs/testing-library";
import OriginBanner from "./OriginBanner";
import { noteForgeUnits, resetSessionActivityForTests, type ForgeUnit } from "../../utils/sessionActivity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

const origin = { session: "parent-1", workspace: "/p/main", at: 1 };

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

beforeEach(() => resetSessionActivityForTests());

describe("OriginBanner", () => {
  it("says who made the worktree a chat runs in", () => {
    noteForgeUnits([unit({ branch: "main", folderPath: "/p/main" }), unit({ madeBy: origin })]);
    const { container } = render(() => <OriginBanner workspace="/p/fix-a" sessionId="child-1" />);
    expect(container.textContent).toBe("Made by another session in p / main");
  });

  it("shows nothing for a worktree nobody recorded", () => {
    noteForgeUnits([unit()]);
    const { container } = render(() => <OriginBanner workspace="/p/fix-a" sessionId="child-1" />);
    expect(container.textContent).toBe("");
  });

  it("shows nothing in the parent's own chat", () => {
    noteForgeUnits([unit({ madeBy: origin })]);
    const { container } = render(() => <OriginBanner workspace="/p/fix-a" sessionId="parent-1" />);
    expect(container.textContent).toBe("");
  });
});
