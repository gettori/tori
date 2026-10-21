import { describe, expect, it, vi } from "vite-plus/test";

const calls: string[] = [];
const handlers = new Map<string, () => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === "autopilot_rules") {
      return Promise.resolve([
        { project: "/p", on: ["check_failed"], max_per_hour: 3, fired_this_hour: 0, paused: false },
      ]);
    }
    return Promise.resolve(cmd === "autopilot_log" ? [] : null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

const { rules, watchAutopilot } = await import("./autopilotStore");

describe("the cockpit's pull request rules", () => {
  it("reads them again when the settings file changes", async () => {
    watchAutopilot();
    await vi.waitFor(() => expect(rules()).toHaveLength(1));
    const before = calls.filter((c) => c === "autopilot_rules").length;
    handlers.get("settings://changed")!();
    await vi.waitFor(() => expect(calls.filter((c) => c === "autopilot_rules").length).toBe(before + 1));
  });
});
