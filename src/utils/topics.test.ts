import { describe, expect, it } from "vite-plus/test";
import {
  topicSelection,
  topicSlug,
  isTopicKey,
  isShellsKey,
  tabUnderFolder,
  memberState,
  rootOf,
  selectionRoot,
  SHELLS_KEY,
  workspaceKey,
  type Topic,
  type Member,
  type MemberState,
} from "./topics";

describe("topicSlug", () => {
  it("suggests a lowercase branch from a name", () => {
    expect(topicSlug("Auth Flow")).toBe("auth-flow");
    expect(topicSlug("  Payments!!  v2 ")).toBe("payments-v2");
    expect(topicSlug("keep_dots.and-dashes")).toBe("keep_dots.and-dashes");
  });

  it("is empty when nothing usable remains", () => {
    expect(topicSlug("!!!")).toBe("");
    expect(topicSlug("")).toBe("");
  });
});

describe("memberState", () => {
  it("only a present member is usable", () => {
    expect(memberState({ kind: "present" })).toMatchObject({ usable: true, action: null });
    expect(memberState({ kind: "worktree-missing" })).toMatchObject({ usable: false, action: "recreate" });
    expect(memberState({ kind: "repo-missing" })).toMatchObject({ usable: false, action: "locate" });
  });

  it("distinguishes a pending creation from a real failure", () => {
    expect(memberState({ kind: "failed", reason: "pending" })).toMatchObject({ label: "Creating", action: null });
    expect(memberState({ kind: "failed", reason: "index.lock exists" })).toMatchObject({
      label: "Failed",
      action: "retry",
      reason: "index.lock exists",
    });
  });
});

const member = (repo: string, wt: string | null, kind: MemberState["kind"], order: number): Member => ({
  repoPath: repo,
  displayName: repo.split("/").pop()!,
  worktreePath: wt,
  state: kind === "failed" ? { kind, reason: "boom" } : ({ kind } as MemberState),
  order,
});
const TOPIC: Topic = {
  id: "f1",
  name: "Auth Flow",
  branch: "feat/auth-flow",
  members: [
    member("/r/b", "/r/b/.tori/worktrees/auth-flow", "present", 1),
    member("/r/a", "/r/a/.tori/worktrees/auth-flow", "present", 0),
    member("/r/c", null, "worktree-missing", 2),
  ],
  createdAt: 1,
};
const A = "/r/a/.tori/worktrees/auth-flow";
const B = "/r/b/.tori/worktrees/auth-flow";

describe("topicSelection", () => {
  it("keeps a stored root that is still present", () => {
    const sel = topicSelection(TOPIC, B);
    expect(sel.kind).toBe("topic");
    expect(sel.topicId).toBe("f1");
    expect(sel.roots).toEqual([A, B]);
    expect(sel.activeRoot).toBe(B);
    expect(sel.folderPath).toBe(B);
    expect(sel.branch).toBe("feat/auth-flow");
  });

  it("falls back to the first present member when the stored root is gone", () => {
    expect(topicSelection(TOPIC, "/r/c/.tori/worktrees/auth-flow").activeRoot).toBe(A);
    expect(topicSelection(TOPIC).activeRoot).toBe(A);
  });

  it("never refuses: no present member opens with a null root and an empty mirror", () => {
    const none = { ...TOPIC, members: [member("/r/c", null, "repo-missing", 0)] };
    const sel = topicSelection(none, A);
    expect(sel.roots).toEqual([]);
    expect(sel.activeRoot).toBeNull();
    expect(sel.folderPath).toBe("");
    expect(selectionRoot(sel)).toBeNull();
  });

  it("opens a references-only Topic on each repo's own checkout, with no worktree path", () => {
    const reference = (
      repoPath: string,
      checkout: string | null,
      kind: MemberState["kind"],
      order: number,
    ): Member => ({
      repoPath,
      displayName: repoPath,
      mode: "reference",
      worktreePath: null,
      checkout: checkout ? { path: checkout, branch: "main", defaultBranch: "main" } : null,
      state: { kind } as MemberState,
      order,
    });
    const research: Topic = {
      ...TOPIC,
      members: [
        reference("/r/web", "/r/web", "present", 1),
        reference("/r/api", "/r/api", "present", 0),
        reference("/c/infra", null, "checkout-missing", 2),
      ],
    };
    const sel = topicSelection(research);
    expect(sel.roots).toEqual(["/r/api", "/r/web"]);
    expect(sel.activeRoot).toBe("/r/api");
  });
});

describe("workspaceKey and selectionRoot", () => {
  const unit = { kind: "unit" as const, folderPath: "/r/a", activeRoot: undefined };

  it("keys a Topic by id and a unit by folder", () => {
    expect(workspaceKey(topicSelection(TOPIC, A))).toBe("topic:f1");
    expect(workspaceKey(unit)).toBe("/r/a");
    expect(workspaceKey({ folderPath: "/r/a" })).toBe("/r/a");
    expect(workspaceKey(null)).toBe("");
  });

  it("roots a Topic at its active member, a unit at its folder, and never returns an empty string", () => {
    expect(selectionRoot(topicSelection(TOPIC, B))).toBe(B);
    expect(selectionRoot(unit)).toBe("/r/a");
    expect(selectionRoot({ kind: "unit", folderPath: "" })).toBeNull();
    expect(selectionRoot(null)).toBeNull();
  });

  it("keys the dock's group by its one constant", () => {
    expect(isShellsKey(SHELLS_KEY)).toBe(true);
    // A path or a Topic key never reads as Shells, and the two synthetic
    // key spaces stay apart.
    expect(isShellsKey("/shells:")).toBe(false);
    expect(isShellsKey("topic:shells:")).toBe(false);
    expect(isTopicKey(SHELLS_KEY)).toBe(false);
  });

  it("tells a Topic key from a path", () => {
    expect(isTopicKey("topic:f1")).toBe(true);
    expect(isTopicKey("/topic:f1")).toBe(false);
  });
});

// One rule for "which member owns this file", shared by the conflict banner,
// the commit target and the palette's git commands.
describe("rootOf", () => {
  it("picks the deepest root that owns the path, and nothing outside them all", () => {
    const roots = ["/r/a", "/r/a/vendor/lib", "/r/b"];
    expect(rootOf("/r/a/src/x.ts", roots)).toBe("/r/a");
    // Nesting is real: a member checked out inside another must answer with
    // itself, or every file in it stages against its host.
    expect(rootOf("/r/a/vendor/lib/src/x.ts", roots)).toBe("/r/a/vendor/lib");
    expect(rootOf("/r/b", roots)).toBe("/r/b");
    expect(rootOf("/r/c/x.ts", roots)).toBeNull();
    expect(rootOf(null, roots)).toBeNull();
    expect(rootOf("/r/a/x.ts", [])).toBeNull();
    // Trailing slashes are normalized, so a root carrying one still owns its
    // files rather than owning them one character off.
    expect(rootOf("/r/a/x.ts", ["/r/a/"])).toBe("/r/a/");
  });
});

// A Spaces row counts a Topic tab by its cwd, and a repo never owns the
// Topic worktrees parked under its own `.tori/worktrees/`: the member
// folder does. Mirrors `sessions::listing_never_claims_a_repos_own_topic_worktrees`.
describe("tabUnderFolder", () => {
  const topicTab = (cwd: string) => ({ workspace: "topic:f1", cwd });

  it("counts a Topic tab on the member folder it was spawned in", () => {
    expect(tabUnderFolder(topicTab("/w/api-auth/src"), "/w/api-auth")).toBe(true);
    expect(tabUnderFolder(topicTab("/w/api-auth"), "/w/api-auth/")).toBe(true);
    expect(tabUnderFolder(topicTab("/w/web-auth"), "/w/api-auth")).toBe(false);
  });

  it("never counts it on a repo whose .tori/worktrees holds the member", () => {
    const cwd = "/w/api/.tori/worktrees/auth/src";
    expect(tabUnderFolder(topicTab(cwd), "/w/api")).toBe(false);
    expect(tabUnderFolder(topicTab(cwd), "/w/api/.tori/worktrees/auth")).toBe(true);
    expect(tabUnderFolder({ workspace: "topic:f1" }, "/w/api")).toBe(false);
  });

  it("keeps the workspace prefix rule for a unit tab", () => {
    expect(tabUnderFolder({ workspace: "/w/api", cwd: "/elsewhere" }, "/w/api")).toBe(true);
    expect(tabUnderFolder({ workspace: "/w/api/.tori/worktrees/x", cwd: "/w/api" }, "/w/api")).toBe(true);
    expect(tabUnderFolder({ workspace: "/w/apix", cwd: "/w/api" }, "/w/api")).toBe(false);
  });
});
