import { describe, it, expect, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { settings?: unknown }) =>
    Promise.resolve(cmd === "set_settings" ? args.settings : null),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));

const { agentRefusal } = await import("./projectAgents");
const { noteTopics } = await import("./topics");
const { saveSettings, settings } = await import("../panels/Settings/settingsStore");

describe("agentRefusal in a Topic's home folder", () => {
  it("applies every member's rule and names the member that refuses", async () => {
    await saveSettings({
      ...settings,
      projectAgents: {
        "/w/api": [{ agent: "claude", profile: "default" }],
        "/w/web": [{ agent: "codex", profile: "default" }],
      },
    });
    const member = (repoPath: string, order: number) => ({
      repoPath,
      displayName: repoPath.split("/").pop()!,
      worktreePath: `${repoPath}/.tori/worktrees/x`,
      state: { kind: "present" as const },
      order,
    });
    noteTopics([
      { id: "x", name: "X", branch: "x", createdAt: 1, home: "/cfg/topics/x", members: [member("/w/api", 0), member("/w/web", 1)] },
    ]);

    const refused = agentRefusal("/cfg/topics/x", "claude", "default");
    expect(refused).toMatch(/not allowed in web, only in api$/);
    expect(agentRefusal("/w/api/.tori/worktrees/x", "claude", "default")).toBeNull();
  });
});
