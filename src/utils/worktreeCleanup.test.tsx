import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { createRoot } from "solid-js";
import type { CleanupFacts } from "./worktreeCleanupVerdict";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  facts: {} as Record<string, CleanupFacts[]>,
  dirtyAtRecheck: new Set<string>(),
  /** Resolves the next `get_config`, so a test can hold a sweep open. */
  gate: null as Promise<void> | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    bridge.calls.push({ cmd, args });
    if (cmd === "get_config") {
      if (bridge.gate) await bridge.gate;
      return {
        spaces: [
          {
            projects: Object.keys(bridge.facts).map((path) => ({ path, branchUnits: [{ kind: "worktree" }] })),
          },
        ],
      };
    }
    if (cmd === "worktree_cleanup_facts") return bridge.facts[args.projectPath as string] ?? [];
    if (cmd === "worktree_dirty") return bridge.dirtyAtRecheck.has(args.path as string);
    if (cmd === "autopilot_state") return { items: [] };
    return null;
  },
}));

const settingsMock = vi.hoisted(() => ({
  set: (_: { cleanupAfterMerge?: boolean; cleanupAfterIdleDays?: number }) => {},
}));
vi.mock("../panels/Settings/settingsStore", async () => {
  const { createStore } = await import("solid-js/store");
  const [settings, setSettings] = createStore({ git: { cleanupAfterMerge: false, cleanupAfterIdleDays: 0 } });
  settingsMock.set = (g) => setSettings("git", (prev) => ({ ...prev, ...g }));
  return { settings };
});

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../components/Toasts/Toasts", () => ({ pushToast: (m: string) => toasts.push(m) }));

vi.mock("./folderActors", () => ({ liveCandidates: () => [], detachedCandidates: async () => [] }));

const forge = vi.hoisted(() => ({ heads: {} as Record<string, Record<string, string>>, report: (_: string) => {} }));
vi.mock("./forgeStatus", () => ({
  mergedHeads: (path: string) => forge.heads[path] ?? {},
  onForgeReport: (fn: (path: string) => void) => {
    forge.report = fn;
    return () => {};
  },
}));

const purged: string[] = [];
window.addEventListener("tori:purge-under-path", (e) => purged.push((e as CustomEvent).detail.path));

const { startWorktreeCleanup } = await import("./worktreeCleanup");

const OLD = Math.floor(Date.now() / 1000) - 30 * 86_400;

function fact(path: string, branch: string, over: Partial<CleanupFacts> = {}): CleanupFacts {
  return { path, branch, head: "h", dirty: false, unpushed: false, lastActivity: OLD, inMergedHead: false, ...over };
}

let stop: (() => void) | undefined;
function start() {
  createRoot((dispose) => {
    const halt = startWorktreeCleanup({ selectedRoot: () => null, openPaths: () => [] });
    stop = () => {
      halt();
      dispose();
    };
  });
}

/** Lets every queued await in a sweep run out. */
const drain = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const removals = () => bridge.calls.filter((c) => c.cmd === "remove_worktree").map((c) => c.args.worktreePath);
const count = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd).length;

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.facts = {};
  bridge.dirtyAtRecheck.clear();
  bridge.gate = null;
  forge.heads = {};
  toasts.length = 0;
  purged.length = 0;
  settingsMock.set({ cleanupAfterMerge: false, cleanupAfterIdleDays: 0 });
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("the worktree cleanup sweep", () => {
  it("asks Rust nothing while both settings are off", async () => {
    bridge.facts = { "/p": [fact("/p/old", "old")] };
    start();
    await drain();
    forge.report("/p");
    await drain();
    expect(bridge.calls).toEqual([]);
  });

  it("purges then removes each eligible worktree, and names the branches once", async () => {
    bridge.facts = {
      "/p": [fact("/p/a", "a"), fact("/p/b", "b"), fact("/p/fresh", "fresh", { lastActivity: OLD + 29 * 86_400 })],
    };
    settingsMock.set({ cleanupAfterIdleDays: 7 });
    start();
    await drain();
    expect(removals()).toEqual(["/p/a", "/p/b"]);
    expect(purged).toEqual(["/p/a", "/p/b"]);
    expect(bridge.calls.find((c) => c.cmd === "remove_worktree")?.args.force).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("a, b");
  });

  it("keeps a worktree that turned dirty at the last check, with no purge", async () => {
    bridge.facts = { "/p": [fact("/p/a", "a")] };
    bridge.dirtyAtRecheck.add("/p/a");
    settingsMock.set({ cleanupAfterIdleDays: 7 });
    start();
    await drain();
    expect(removals()).toEqual([]);
    expect(purged).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("queues exactly one rerun for two triggers that land mid-sweep", async () => {
    let open!: () => void;
    bridge.gate = new Promise((r) => (open = r));
    bridge.facts = { "/p": [] };
    settingsMock.set({ cleanupAfterIdleDays: 7, cleanupAfterMerge: true });
    forge.heads = { "/p": { feat: "h" } };
    start();
    await drain();
    expect(count("get_config")).toBe(1);
    forge.report("/p");
    forge.report("/p");
    await drain();
    bridge.gate = null;
    open();
    await drain();
    expect(count("get_config")).toBe(2);
    expect(count("worktree_cleanup_facts")).toBe(2);
  });

  it("rechecks only the reported project, for the merge rule alone", async () => {
    bridge.facts = {
      "/p": [fact("/p/merged", "merged", { inMergedHead: true, lastActivity: Math.floor(Date.now() / 1000) })],
      "/q": [fact("/q/idle", "idle")],
    };
    forge.heads = { "/p": { merged: "h" } };
    settingsMock.set({ cleanupAfterMerge: true });
    start();
    await drain();
    bridge.calls.length = 0;
    bridge.facts["/p"] = [fact("/p/merged2", "merged2", { inMergedHead: true })];
    forge.heads = { "/p": { merged2: "h" } };
    settingsMock.set({ cleanupAfterIdleDays: 0 });
    await drain();
    bridge.calls.length = 0;
    forge.report("/p");
    await drain();
    const asked = bridge.calls.filter((c) => c.cmd === "worktree_cleanup_facts").map((c) => c.args.projectPath);
    expect(asked).toEqual(["/p"]);
    expect(removals()).toEqual(["/p/merged2"]);
  });

  it("shows no toast when a sweep removes nothing", async () => {
    bridge.facts = { "/p": [fact("/p/busy", "busy", { dirty: true })] };
    settingsMock.set({ cleanupAfterIdleDays: 7 });
    start();
    await drain();
    expect(toasts).toEqual([]);
  });
});
