import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import { rememberSelection, rememberedInSpace, rememberedGlobal } from "./selectionMemory";
import type { Selection } from "../panels/LeftSidebar/LeftSidebar";

const unit = (spaceName: string, folderPath: string): Selection => ({
  kind: "unit",
  spaceName,
  projectName: "repo",
  projectPath: "/r/repo",
  folderPath,
  branch: "main",
  projectKind: "worktree",
  profile: null,
});

const topic = (topicId: string, spaceName: string, folderPath = ""): Selection => ({
  kind: "topic",
  topicId,
  topicName: topicId,
  spaceName,
  projectName: topicId,
  projectPath: folderPath,
  folderPath,
  branch: topicId,
  projectKind: "topic",
  profile: null,
});

describe("selection memory", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it("keeps a space Topic under its space and a global one in Global's slot", () => {
    rememberSelection(topic("global", ""));
    rememberSelection(topic("pay", "work"));
    expect(rememberedInSpace("work")?.topicId).toBe("pay");
    expect(rememberedGlobal()?.topicId).toBe("global");
  });

  it("lets a unit and a space Topic take turns in one space's slot", () => {
    rememberSelection(topic("pay", "work", "/r/repo/pay"));
    rememberSelection(unit("work", "/r/repo/main"));
    expect(rememberedInSpace("work")?.kind).toBe("unit");
    rememberSelection(topic("pay", "work"));
    expect(rememberedInSpace("work")?.kind).toBe("topic");
    expect(rememberedGlobal()).toBeNull();
  });
});
