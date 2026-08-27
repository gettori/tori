import { describe, expect, it } from "vitest";
import {
  featureSelection,
  featureSlug,
  isFeatureKey,
  tabUnderFolder,
  memberInitials,
  memberState,
  rootOf,
  selectionRoot,
  workspaceFolders,
  workspaceKey,
  type Feature,
  type Member,
  type MemberState,
} from "./features";

// The slug is what every member's branch is named after, so the frontend and
// backend rules have to agree character for character: these cases mirror
// `features::tests::slug_lowercases_collapses_and_rejects_empty`.
describe("featureSlug", () => {
  it("matches the backend rule", () => {
    expect(featureSlug("Auth Flow")).toBe("auth-flow");
    expect(featureSlug("  Payments!!  v2 ")).toBe("payments-v2");
    expect(featureSlug("keep_dots.and-dashes")).toBe("keep_dots.and-dashes");
  });

  it("is empty when nothing usable remains", () => {
    expect(featureSlug("!!!")).toBe("");
    expect(featureSlug("")).toBe("");
  });
});

describe("memberInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(memberInitials({ displayName: "Backend API", repoPath: "/r/x" })).toBe("BA");
    expect(memberInitials({ displayName: "web", repoPath: "/r/x" })).toBe("W");
    expect(memberInitials({ displayName: "saga-frontend", repoPath: "/r/x" })).toBe("SF");
  });

  it("falls back to the repo basename", () => {
    expect(memberInitials({ displayName: "  ", repoPath: "/Users/a/Projects/net_check" })).toBe("NC");
    expect(memberInitials({ displayName: "", repoPath: "" })).toBe("");
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
const FEATURE: Feature = {
  id: "f1",
  name: "Auth Flow",
  branch: "feat/auth-flow",
  members: [
    member("/r/b", "/r/b/.sway/worktrees/auth-flow", "present", 1),
    member("/r/a", "/r/a/.sway/worktrees/auth-flow", "present", 0),
    member("/r/c", null, "worktree-missing", 2),
  ],
  createdAt: 1,
};
const A = "/r/a/.sway/worktrees/auth-flow";
const B = "/r/b/.sway/worktrees/auth-flow";

describe("featureSelection", () => {
  it("keeps a stored root that is still present", () => {
    const sel = featureSelection(FEATURE, B);
    expect(sel.kind).toBe("feature");
    expect(sel.featureId).toBe("f1");
    expect(sel.roots).toEqual([A, B]);
    expect(sel.activeRoot).toBe(B);
    expect(sel.folderPath).toBe(B);
    expect(sel.branch).toBe("feat/auth-flow");
  });

  it("falls back to the first present member when the stored root is gone", () => {
    expect(featureSelection(FEATURE, "/r/c/.sway/worktrees/auth-flow").activeRoot).toBe(A);
    expect(featureSelection(FEATURE).activeRoot).toBe(A);
  });

  it("never refuses: no present member opens with a null root and an empty mirror", () => {
    const none = { ...FEATURE, members: [member("/r/c", null, "repo-missing", 0)] };
    const sel = featureSelection(none, A);
    expect(sel.roots).toEqual([]);
    expect(sel.activeRoot).toBeNull();
    expect(sel.folderPath).toBe("");
    expect(selectionRoot(sel)).toBeNull();
  });
});

describe("workspaceKey and selectionRoot", () => {
  const unit = { kind: "unit" as const, folderPath: "/r/a", activeRoot: undefined };

  it("keys a Feature by id and a unit by folder", () => {
    expect(workspaceKey(featureSelection(FEATURE, A))).toBe("feature:f1");
    expect(workspaceKey(unit)).toBe("/r/a");
    expect(workspaceKey({ folderPath: "/r/a" })).toBe("/r/a");
    expect(workspaceKey(null)).toBe("");
  });

  it("roots a Feature at its active member, a unit at its folder, and never returns an empty string", () => {
    expect(selectionRoot(featureSelection(FEATURE, B))).toBe(B);
    expect(selectionRoot(unit)).toBe("/r/a");
    expect(selectionRoot({ kind: "unit", folderPath: "" })).toBeNull();
    expect(selectionRoot(null)).toBeNull();
  });

  it("spans the selected Feature's roots and nothing for an unselected one", () => {
    const sel = featureSelection(FEATURE, A);
    expect(workspaceFolders("feature:f1", sel)).toEqual([A, B]);
    expect(workspaceFolders("feature:other", sel)).toEqual([]);
    expect(workspaceFolders("/r/a", sel)).toEqual(["/r/a"]);
    expect(isFeatureKey("feature:f1")).toBe(true);
    expect(isFeatureKey("/feature:f1")).toBe(false);
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

// A Spaces row counts a Feature tab by its cwd, and a repo never owns the
// Feature worktrees parked under its own `.sway/worktrees/`: the member
// folder does. Mirrors `sessions::listing_never_claims_a_repos_own_feature_worktrees`.
describe("tabUnderFolder", () => {
  const featureTab = (cwd: string) => ({ workspace: "feature:f1", cwd });

  it("counts a Feature tab on the member folder it was spawned in", () => {
    expect(tabUnderFolder(featureTab("/w/api-auth/src"), "/w/api-auth")).toBe(true);
    expect(tabUnderFolder(featureTab("/w/api-auth"), "/w/api-auth/")).toBe(true);
    expect(tabUnderFolder(featureTab("/w/web-auth"), "/w/api-auth")).toBe(false);
  });

  it("never counts it on a repo whose .sway/worktrees holds the member", () => {
    const cwd = "/w/api/.sway/worktrees/auth/src";
    expect(tabUnderFolder(featureTab(cwd), "/w/api")).toBe(false);
    expect(tabUnderFolder(featureTab(cwd), "/w/api/.sway/worktrees/auth")).toBe(true);
    expect(tabUnderFolder({ workspace: "feature:f1" }, "/w/api")).toBe(false);
  });

  it("keeps the workspace prefix rule for a unit tab", () => {
    expect(tabUnderFolder({ workspace: "/w/api", cwd: "/elsewhere" }, "/w/api")).toBe(true);
    expect(tabUnderFolder({ workspace: "/w/api/.sway/worktrees/x", cwd: "/w/api" }, "/w/api")).toBe(true);
    expect(tabUnderFolder({ workspace: "/w/apix", cwd: "/w/api" }, "/w/api")).toBe(false);
  });
});
