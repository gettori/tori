// A Feature as the backend records it (`src-tauri/src/features.rs`), plus the
// pure helpers the Feature UI needs. Nothing here talks to the backend: the
// slug rule mirrors `features::feature_slug` so a creation dialog can show the
// branch before asking, and the two member helpers exist so a chip and a state
// badge do not each re-derive them.

import type { Selection } from "../panels/LeftSidebar/LeftSidebar";

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

/** The workspace key prefix for a Feature: `feature:<id>`. A path never starts
 *  with it, so the two key spaces cannot collide. */
export const FEATURE_KEY_PREFIX = "feature:";

export function featureKey(id: string): string {
  return FEATURE_KEY_PREFIX + id;
}

export function isFeatureKey(ws: string | null | undefined): boolean {
  return !!ws && ws.startsWith(FEATURE_KEY_PREFIX);
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
  };
}

/** What every per-workspace store keys on: `feature:<id>` for a Feature, the
 *  branch-unit folder otherwise, empty for nothing selected. */
export function workspaceKey(sel: Pick<Selection, "kind" | "featureId" | "folderPath"> | null | undefined): string {
  if (!sel) return "";
  if (sel.kind === "feature" && sel.featureId) return featureKey(sel.featureId);
  return sel.folderPath ?? "";
}

/** The folder git, settings, the watcher and a spawn run against: the active
 *  member for a Feature, the branch-unit folder otherwise. Null, never "". */
export function selectionRoot(
  sel: Pick<Selection, "kind" | "activeRoot" | "folderPath"> | null | undefined,
): string | null {
  if (!sel) return null;
  if (sel.kind === "feature") return sel.activeRoot ?? null;
  return sel.folderPath || null;
}

/** The folders a `feature:<id>` workspace spans, for a per-folder backend call
 *  that has to be unioned; a plain workspace is its own single folder. */
export function workspaceFolders(ws: string, sel: Selection | null | undefined): string[] {
  if (!isFeatureKey(ws)) return [ws];
  if (sel && workspaceKey(sel) === ws) return sel.roots ?? [];
  return [];
}
