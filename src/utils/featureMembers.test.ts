// The shared tinted-members resource (#155 phase 2). Two events can change what
// a member chip says: the Feature record itself and the Space list it takes its
// colour from. Each has to refetch exactly the half it invalidates.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";

const bridge = vi.hoisted(() => ({
  calls: [] as string[],
  members: [
    { repoPath: "/w/api", displayName: "api", worktreePath: "/w/api/wt", state: { kind: "present" }, order: 1 },
    { repoPath: "/tmp/scratch", displayName: "scratch", worktreePath: null, state: { kind: "worktree-missing" }, order: 0 },
  ] as unknown[],
  spaces: [{ name: "work", color: "Sky", projects: [{ path: "/w/api" }] }] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.calls.push(cmd);
    if (cmd === "list_features")
      return Promise.resolve([{ id: "f1", name: "Auth", branch: "feat/auth", createdAt: 1, members: bridge.members }]);
    if (cmd === "get_config") return Promise.resolve({ spaces: bridge.spaces });
    return Promise.resolve(null);
  },
}));

const handlers = vi.hoisted(() => ({} as Record<string, () => void>));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  },
}));

const { createFeatureMembers, resolveMemberRestriction, tintedMembers } = await import(
  "./featureMembers"
);

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const count = (cmd: string) => bridge.calls.filter((c) => c === cmd).length;

beforeEach(() => {
  bridge.calls.length = 0;
});

describe("createFeatureMembers", () => {
  it("refetches once per event and keeps the members in order, tinted by Space", async () => {
    await createRoot(async (dispose) => {
      const members = createFeatureMembers(() => "f1");
      await settle();
      expect(count("list_features")).toBe(1);
      expect(count("get_config")).toBe(1);
      // Sorted by `order`, so the scratch member (order 0) leads.
      expect(members().map((m) => m.label)).toEqual(["scratch", "api"]);
      expect(members()[0].key).toBe("/tmp/scratch");
      expect(members()[0].hue).toBeUndefined();
      expect(members()[0].state.action).toBe("recreate");
      expect(members()[1].key).toBe("/w/api/wt");
      expect(members()[1].hue).toBeTruthy();
      expect(members()[1].style?.["--chip-rgb"]).toBeTruthy();

      handlers["features://changed"]();
      await settle();
      expect(count("list_features")).toBe(2);
      expect(count("get_config")).toBe(2);

      handlers["config://changed"]();
      await settle();
      expect(count("list_features")).toBe(3);
      expect(count("get_config")).toBe(3);
      dispose();
    });
  });

  it("reads nothing when no Feature is selected", async () => {
    await createRoot(async (dispose) => {
      const members = createFeatureMembers(() => null);
      await settle();
      expect(bridge.calls).toEqual([]);
      expect(members()).toEqual([]);
      dispose();
    });
  });

  it("reads once per generation however many consumers ask", async () => {
    await createRoot(async (dispose) => {
      const a = createFeatureMembers(() => "f1");
      const b = createFeatureMembers(() => "f1");
      await settle();
      bridge.calls.length = 0;

      handlers["features://changed"]();
      await settle();
      expect(count("list_features")).toBe(1);
      expect(count("get_config")).toBe(1);
      expect(a().map((m) => m.key)).toEqual(b().map((m) => m.key));
      dispose();
    });
  });
});

describe("tintedMembers", () => {
  it("is empty for no Feature and neutral for a repo outside every Space", () => {
    expect(tintedMembers(null, [])).toEqual([]);
    const [first] = tintedMembers({ members: bridge.members as never }, []);
    expect(first.hue).toBeUndefined();
    expect(first.style).toBeUndefined();
  });
});

describe("resolveMemberRestriction", () => {
  // Repo paths, not section paths, and this is the whole reason: a Recreate
  // moves the worktree and the member is still the one that was picked.
  const here = [
    { repoPath: "/repos/api" },
    { repoPath: "/repos/web" },
  ];

  it("holds when a member's worktree moved but its repo did not", () => {
    expect(resolveMemberRestriction(["/repos/api"], here)).toEqual(["/repos/api"]);
  });

  it("drops a member that left, keeping the rest", () => {
    expect(resolveMemberRestriction(["/repos/api", "/repos/docs"], here)).toEqual(["/repos/api"]);
  });

  it("falls back to every member when none of them resolve", () => {
    // Searching nothing for a query that used to work reads as a broken saved
    // search; an empty list is the panel's "no restriction" value.
    expect(resolveMemberRestriction(["/repos/docs"], here)).toEqual([]);
    expect(resolveMemberRestriction([], here)).toEqual([]);
    expect(resolveMemberRestriction(undefined, here)).toEqual([]);
  });
});
