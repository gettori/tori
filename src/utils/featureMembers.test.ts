// The shared tinted-members resource (#155 phase 2). Two events can change what
// a member chip says: the Feature record itself and the Space list it takes its
// colour from. Each has to refetch exactly the half it invalidates.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import type { TintedMember } from "./featureMembers";

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
// Never reset between tests: the module registers its listeners once for the
// whole file, which is the property the last test here asserts.
const listens = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    listens.push(name);
    handlers[name] = cb;
    return Promise.resolve(() => {});
  },
}));

const {
  createFeatureMembers,
  groupByMemberRoot,
  memberFor,
  memberSectionsHeaded,
  resolveMemberRestriction,
  tintedMembers,
} = await import("./featureMembers");

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

  it("watches each source once, however many consumers mount", async () => {
    // What lets the Editor and the Terminal both draw member chips without a
    // second `list_features` or a second listener pair: the module shares one
    // read per generation, so neither panel has to own the resource.
    await createRoot(async (dispose) => {
      createFeatureMembers(() => "f1");
      createFeatureMembers(() => "f1");
      await settle();
      expect(listens.filter((n) => n === "features://changed")).toHaveLength(1);
      expect(listens.filter((n) => n === "config://changed")).toHaveLength(1);
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

describe("memberFor", () => {
  const tinted = (worktreePath: string | null, displayName: string, kind = "present"): TintedMember =>
    ({
      member: { repoPath: `/repos/${displayName}`, displayName, worktreePath, state: { kind }, order: 0 },
      key: worktreePath ?? `/repos/${displayName}`,
      label: displayName,
      state: { label: "", usable: kind === "present", action: null, reason: null },
      hue: undefined,
      style: undefined,
    }) as TintedMember;

  const OUTER = tinted("/w/outer", "outer");
  const INNER = tinted("/w/outer/vendor/inner", "inner");
  const BROKEN = tinted("/w/gone", "gone", "worktree-missing");
  const NO_WORKTREE = tinted(null, "pending", "failed");
  const ALL = [OUTER, INNER, BROKEN, NO_WORKTREE];

  it("picks the deeper member when one is nested inside another", () => {
    expect(memberFor("/w/outer/vendor/inner/src/app.ts", ALL)?.label).toBe("inner");
    expect(memberFor("/w/outer/src/app.ts", ALL)?.label).toBe("outer");
  });

  it("still resolves a file whose worktree is gone", () => {
    // The tab outlives the worktree, and a tab with no chip in a strip of
    // chips reads as "belongs to no repo" rather than "its repo is broken".
    expect(memberFor("/w/gone/src/app.ts", ALL)?.label).toBe("gone");
  });

  it("resolves on the worktree, so a rename moves no file to another member", () => {
    // A display name is the one field a rename touches (#159 phase 1), and the
    // match has never read it. The chip over an open tab gets the new name; the
    // tab does not change repo under it.
    const renamed = [{ ...OUTER, label: "Payments API" }, INNER, BROKEN, NO_WORKTREE];
    expect(memberFor("/w/outer/src/app.ts", renamed)?.member.repoPath).toBe("/repos/outer");
    expect(memberFor("/w/outer/src/app.ts", renamed)?.label).toBe("Payments API");
  });

  it("matches the root itself, not just what is under it", () => {
    expect(memberFor("/w/outer", ALL)?.label).toBe("outer");
  });

  it("returns null outside every member, and for a member with no worktree", () => {
    expect(memberFor("/elsewhere/app.ts", ALL)).toBeNull();
    expect(memberFor("/repos/pending/app.ts", ALL)).toBeNull();
    // A sibling whose path merely shares a prefix is not inside it.
    expect(memberFor("/w/outer-other/app.ts", ALL)).toBeNull();
  });

  it("answers null rather than throwing on nothing", () => {
    expect(memberFor(null, ALL)).toBeNull();
    expect(memberFor("/w/outer/a.ts", [])).toBeNull();
    expect(memberFor("/w/outer/a.ts", undefined)).toBeNull();
  });
});

describe("groupByMemberRoot", () => {
  const root = (label: string, path: string, usable = true) => ({
    path,
    repoPath: path,
    label,
    state: { label: usable ? "Ready" : "Worktree missing", usable, action: null, reason: null },
  });
  const ROOTS = [root("api", "/w/api"), root("web", "/w/web")];
  const at = (path: string) => ({ path });

  it("puts each row under the member it is in, in member order", () => {
    const groups = groupByMemberRoot(
      [at("/w/web/src/a.ts"), at("/w/api/src/b.ts"), at("/w/web/src/c.ts")],
      (r) => r.path,
      ROOTS,
    );
    expect(groups.map((g) => g.root?.label)).toEqual(["api", "web"]);
    expect(groups[0].items.map((i) => i.path)).toEqual(["/w/api/src/b.ts"]);
    expect(groups[1].items.map((i) => i.path)).toEqual(["/w/web/src/a.ts", "/w/web/src/c.ts"]);
  });

  it("collects a row under no member in a trailing bucket rather than losing it", () => {
    // Removing a repository keeps its worktree by default, so the marks that
    // point into it are still about files on disk.
    const rows = [at("/w/api/a.ts"), at("/gone/b.ts"), at("/gone/c.ts")];
    const groups = groupByMemberRoot(rows, (r) => r.path, ROOTS);
    expect(groups).toHaveLength(3);
    expect(groups[2].root).toBeNull();
    expect(groups[2].items.map((i) => i.path)).toEqual(["/gone/b.ts", "/gone/c.ts"]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(rows.length);
  });

  it("leaves the trailing bucket off when every row is in a member", () => {
    const groups = groupByMemberRoot([at("/w/api/a.ts")], (r) => r.path, ROOTS);
    expect(groups.every((g) => g.root)).toBe(true);
  });

  it("keeps an empty group for a member with nothing in it", () => {
    // The section is where an unusable member says why it is empty, so it has
    // to survive having no rows.
    const groups = groupByMemberRoot([at("/w/api/a.ts")], (r) => r.path, ROOTS);
    expect(groups[1].items).toEqual([]);
  });

  it("gives a nested member its own rows, longest match winning", () => {
    const nested = [root("outer", "/w"), root("inner", "/w/api")];
    const groups = groupByMemberRoot([at("/w/api/a.ts")], (r) => r.path, nested);
    expect(groups[0].items).toEqual([]);
    expect(groups[1].items.map((i) => i.path)).toEqual(["/w/api/a.ts"]);
  });

  it("counts a row once when two members share a path", () => {
    const twice = [root("api", "/w/api"), root("api again", "/w/api")];
    const groups = groupByMemberRoot([at("/w/api/a.ts")], (r) => r.path, twice);
    expect(groups.flatMap((g) => g.items)).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });

  it("puts everything outside when there are no members to be inside of", () => {
    const groups = groupByMemberRoot([at("/w/api/a.ts")], (r) => r.path, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBeNull();
  });
});

describe("memberSectionsHeaded", () => {
  const root = (path: string, usable: boolean) => ({
    path,
    repoPath: path,
    label: path,
    state: { label: usable ? "Ready" : "Worktree missing", usable, action: null, reason: null },
  });

  it("heads nothing for a branch unit or a lone healthy member", () => {
    expect(memberSectionsHeaded(undefined)).toBe(false);
    expect(memberSectionsHeaded([])).toBe(false);
    expect(memberSectionsHeaded([root("/w/api", true)])).toBe(false);
  });

  it("heads a lone member that cannot be opened, so it can say why", () => {
    expect(memberSectionsHeaded([root("/w/api", false)])).toBe(true);
  });

  it("heads every member once there is more than one", () => {
    expect(memberSectionsHeaded([root("/w/api", true), root("/w/web", true)])).toBe(true);
  });
});
