// A Feature as the backend records it (`src-tauri/src/features.rs`), plus the
// pure helpers the Feature UI needs. Nothing here talks to the backend: the
// slug rule mirrors `features::feature_slug` so a creation dialog can show the
// branch before asking, and the two member helpers exist so a chip and a state
// badge do not each re-derive them.

import type { Selection } from "../panels/LeftSidebar/LeftSidebar";
import { isUnderPath } from "./pathScope";

export type MemberState =
  | { kind: "present" }
  | { kind: "worktree-missing" }
  | { kind: "repo-missing" }
  | { kind: "failed"; reason: string };

export type Member = {
  repoPath: string;
  displayName: string;
  worktreePath: string | null;
  state: MemberState;
  order: number;
};

export type Feature = {
  id: string;
  name: string;
  /** `feat/<slug>`, frozen at creation. */
  branch: string;
  members: Member[];
  createdAt: number;
};

/** The branch slug for a Feature name, the same rule as the backend: every
 *  character outside `[A-Za-z0-9._-]` becomes `-`, lowercased, runs of `-`
 *  collapsed, edges trimmed. Empty when nothing usable remains, so the dialog
 *  can refuse before the backend does. */
export function featureSlug(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One or two letters for a member chip: the first letter of the first two
 *  words of the display name, falling back to the repo basename. */
export function memberInitials(member: Pick<Member, "displayName" | "repoPath">): string {
  const source = member.displayName.trim() || member.repoPath.split("/").filter(Boolean).pop() || "";
  const words = source.split(/[\s_-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]);
  return letters.join("").toUpperCase();
}

export type MemberStateSummary = {
  label: string;
  /** Whether the member can be opened as a workspace root right now. */
  usable: boolean;
  /** The repair the UI should offer, if any. */
  action: "recreate" | "locate" | "retry" | null;
  /** The failure text, for a tooltip; only a failed member carries one. */
  reason: string | null;
};

/** The repair a broken member offers. `memberState` chooses it; this names it.
 *  One table because four surfaces draw the button (the sidebar's member list,
 *  the editor's file tree, its Changes sections, and whatever comes next), and
 *  a second copy is how one of them ends up saying Locate and running a retry. */
export type RepairAction = NonNullable<MemberStateSummary["action"]>;
export const REPAIR_LABEL: Record<RepairAction, string> = {
  recreate: "Recreate",
  locate: "Locate",
  retry: "Retry",
};

/** Reads the backend's tagged state into what a badge needs to render. */
export function memberState(state: MemberState): MemberStateSummary {
  switch (state.kind) {
    case "present":
      return { label: "Ready", usable: true, action: null, reason: null };
    case "worktree-missing":
      return { label: "Worktree missing", usable: false, action: "recreate", reason: null };
    case "repo-missing":
      return { label: "Repository unavailable", usable: false, action: "locate", reason: null };
    case "failed":
      return {
        label: state.reason === "pending" ? "Creating" : "Failed",
        usable: false,
        action: state.reason === "pending" ? null : "retry",
        reason: state.reason,
      };
  }
}

/** What `features::remove_member` answers when the last member would go. The
 *  row menu draws it on a refusing Remove rather than waiting for the click to
 *  fail; the Rust constant `features::LAST_MEMBER` is the same string. */
export const LAST_MEMBER = "A Feature needs at least one repository. Delete the Feature instead.";

/** The workspace key prefix for a Feature: `feature:<id>`. A path never starts
 *  with it, so the two key spaces cannot collide. */
export const FEATURE_KEY_PREFIX = "feature:";

export function featureKey(id: string): string {
  return FEATURE_KEY_PREFIX + id;
}

export function isFeatureKey(ws: string | null | undefined): boolean {
  return !!ws && ws.startsWith(FEATURE_KEY_PREFIX);
}

/** The one workspace key for Sway's own command tabs. Synthetic like a Feature's,
 *  so no branch unit's strip can ever be keyed on it (adr_jobs_leave_the_tab_model). */
export const SHELLS_KEY = "shells:";

export function isShellsKey(ws: string | null | undefined): boolean {
  return ws === SHELLS_KEY;
}

/** The Selection the Shells workspace opens as: no folder, no branch, no session. */
export function shellsSelection(): Selection {
  return {
    kind: "shells",
    spaceName: "",
    projectName: "Shells",
    projectPath: "",
    folderPath: "",
    branch: "",
    projectKind: "shells",
    profile: null,
  };
}

/** The present members' worktree folders, in member order. */
export function featureRoots(feature: Pick<Feature, "members">): string[] {
  return feature.members
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((m) => m.state.kind === "present" && !!m.worktreePath)
    .map((m) => m.worktreePath!);
}

/** The Selection a Feature opens as. Never refuses: a stale stored root falls
 *  back to the first present member, none present opens with `activeRoot: null`.
 *  `folderPath` mirrors `activeRoot` for consumers still on the flat field. */
export function featureSelection(feature: Feature, storedActiveRoot?: string | null): Selection {
  const roots = featureRoots(feature);
  const activeRoot = storedActiveRoot && roots.includes(storedActiveRoot) ? storedActiveRoot : (roots[0] ?? null);
  return {
    kind: "feature",
    featureId: feature.id,
    featureName: feature.name,
    roots,
    activeRoot,
    spaceName: "",
    projectName: feature.name,
    projectPath: activeRoot ?? "",
    folderPath: activeRoot ?? "",
    branch: feature.branch,
    projectKind: "feature",
    // No session selected yet, so no account: a Feature is a set of branches,
    // and the profile arrives with the session picked inside it.
    profile: null,
  };
}

/** The root that owns `path`, longest match first so a member nested inside
 *  another still answers with itself. Null outside every root, which is what
 *  "this file belongs to no member" has to read as.
 *
 *  One rule, shared by the conflict banner, the commit target and the palette's
 *  git commands: three copies of it is how the three disagree about which repo
 *  the file in front of you is in. */
export function rootOf(
  path: string | null | undefined,
  roots: readonly string[] | null | undefined,
): string | null {
  if (!path || !roots?.length) return null;
  let best: string | null = null;
  for (const r of roots) {
    if (!r || !isUnderPath(path, r)) continue;
    if (!best || r.length > best.length) best = r;
  }
  return best;
}

/** What every per-workspace store keys on: `feature:<id>` for a Feature, `shells:`
 *  for Shells, the branch-unit folder otherwise, empty for nothing selected. */
export function workspaceKey(sel: Pick<Selection, "kind" | "featureId" | "folderPath"> | null | undefined): string {
  if (!sel) return "";
  if (sel.kind === "feature" && sel.featureId) return featureKey(sel.featureId);
  if (sel.kind === "shells") return SHELLS_KEY;
  return sel.folderPath ?? "";
}

/** The folder git, settings, the watcher and a spawn run against: the active
 *  member for a Feature, none for Shells, the branch-unit folder otherwise.
 *  Null, never "". */
export function selectionRoot(
  sel: Pick<Selection, "kind" | "activeRoot" | "folderPath"> | null | undefined,
): string | null {
  if (!sel) return null;
  if (sel.kind === "feature") return sel.activeRoot ?? null;
  if (sel.kind === "shells") return null;
  return sel.folderPath || null;
}

/** The folders a `feature:<id>` workspace spans, for a per-folder backend call
 *  that has to be unioned; a plain workspace is its own single folder. */
export function workspaceFolders(ws: string, sel: Selection | null | undefined): string[] {
  if (!isFeatureKey(ws)) return [ws];
  if (sel && workspaceKey(sel) === ws) return sel.roots ?? [];
  return [];
}

/** Does `folder` own a cwd for attribution: at or under it, but never under
 *  the folder's own `.sway/worktrees/`, where its Feature worktrees live and
 *  which the member folder claims by prefix instead. The same rule as the
 *  backend's `sessions::owned_by_listing`. */
export function ownsCwd(cwd: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  return isUnderPath(cwd, f) && !cwd.replace(/\/+$/, "").startsWith(`${f}/.sway/worktrees/`);
}

/** Whether a live tab counts as running under a Spaces folder: a unit tab by
 *  its workspace, a Feature tab by where it was spawned. */
export function tabUnderFolder(tab: { workspace: string; cwd?: string }, folder: string): boolean {
  if (isFeatureKey(tab.workspace)) return !!tab.cwd && ownsCwd(tab.cwd, folder);
  return isUnderPath(tab.workspace, folder);
}
