// A Topic as the backend records it (`src-tauri/src/topics.rs`), plus the
// pure helpers the Topic UI needs. Nothing here talks to the backend: the
// slug rule suggests a branch for a creation dialog, and the two member
// helpers exist so a chip and a state badge do not each re-derive them.

import type { Selection } from "../panels/LeftSidebar/LeftSidebar";
import { invoke } from "@tauri-apps/api/core";
import { isUnderPath } from "./pathScope";

export type MemberState =
  | { kind: "present" }
  | { kind: "worktree-missing" }
  | { kind: "repo-missing" }
  | { kind: "checkout-missing" }
  | { kind: "failed"; reason: string };

/** What the user asked a member to be; `state` is what git says it is. */
export type MemberMode = "reference" | "worktree";

/** Where a reference member reads from, refreshed by every reconcile. */
export type Checkout = {
  path: string;
  branch: string | null;
  defaultBranch: string | null;
};

export type Member = {
  repoPath: string;
  displayName: string;
  /** Absent on a record the backend wrote before modes existed. */
  mode?: MemberMode;
  /** Only ever a worktree this Topic owns; a reference keeps it null, so no
   *  removal or purge keyed on it can reach the user's own checkout. */
  worktreePath: string | null;
  checkout?: Checkout | null;
  state: MemberState;
  order: number;
};

/** What a chat gets when it asks for a worktree in a member it may only read. */
export type Promotion = "ask" | "auto" | "never";

export type Topic = {
  id: string;
  name: string;
  /** Exactly what the user typed, frozen at creation. */
  branch: string;
  members: Member[];
  createdAt: number;
  /** Absent on a record the backend wrote before the setting existed. */
  promotion?: Promotion;
  /** The folder the Topic's chats run in. Filled by the backend on every read. */
  home?: string;
};

/** The branch a creation dialog suggests for a Topic name: every character
 *  outside `[A-Za-z0-9._-]` becomes `-`, lowercased, runs of `-` collapsed,
 *  edges trimmed. Empty when nothing usable remains. */
export function topicSlug(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type MemberStateSummary = {
  label: string;
  /** Whether the member can be opened as a workspace root right now. */
  usable: boolean;
  /** The repair the UI should offer, if any. */
  action: "recreate" | "locate" | "retry" | "checkout" | null;
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
  checkout: "Check out",
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
    case "checkout-missing":
      return { label: "No default branch checkout", usable: false, action: "checkout", reason: null };
    case "failed":
      return {
        label: state.reason === "pending" ? "Creating" : "Failed",
        usable: false,
        action: state.reason === "pending" ? null : "retry",
        reason: state.reason,
      };
  }
}

/** What `topics::remove_member` answers when the last member would go. The
 *  row menu draws it on a refusing Remove rather than waiting for the click to
 *  fail; the Rust constant `topics::LAST_MEMBER` is the same string. */
export const LAST_MEMBER = "A Topic needs at least one repository. Delete the Topic instead.";

/** The workspace key prefix for a Topic: `topic:<id>`. A path never starts
 *  with it, so the two key spaces cannot collide. */
export const TOPIC_KEY_PREFIX = "topic:";

export function topicKey(id: string): string {
  return TOPIC_KEY_PREFIX + id;
}

export function isTopicKey(ws: string | null | undefined): boolean {
  return !!ws && ws.startsWith(TOPIC_KEY_PREFIX);
}

/** The one workspace key for Tori's own command tabs, the group the dock draws.
 *  Synthetic like a Topic's, so no branch unit's strip can ever be keyed on it
 *  (adr_jobs_leave_the_tab_model). */
export const SHELLS_KEY = "shells:";

export function isShellsKey(ws: string | null | undefined): boolean {
  return ws === SHELLS_KEY;
}

export function isReference(member: Pick<Member, "mode">): boolean {
  return member.mode === "reference";
}

/** The folder a member opens as, or null when it cannot be opened. The one
 *  way to a member's root: a reference has no `worktreePath` by design. */
export function memberRoot(member: Pick<Member, "mode" | "worktreePath" | "checkout" | "state">): string | null {
  if (member.state.kind !== "present") return null;
  return (isReference(member) ? member.checkout?.path : member.worktreePath) ?? null;
}

/** The branch a member's root has checked out: the Topic's for a worktree,
 *  whatever the checkout is on for a reference. */
export function memberBranch(member: Pick<Member, "mode" | "checkout">, topicBranch: string): string | null {
  return isReference(member) ? (member.checkout?.branch ?? null) : topicBranch;
}

/** The present members' roots, in member order. */
export function topicRoots(topic: Pick<Topic, "members">): string[] {
  return topic.members
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(memberRoot)
    .filter((root): root is string => !!root);
}

/** The Selection a Topic opens as. Never refuses: a stale stored root falls
 *  back to the first present member, none present opens with `activeRoot: null`.
 *  `folderPath` mirrors `activeRoot` for consumers still on the flat field. */
export function topicSelection(topic: Topic, storedActiveRoot?: string | null): Selection {
  const roots = topicRoots(topic);
  const activeRoot = storedActiveRoot && roots.includes(storedActiveRoot) ? storedActiveRoot : (roots[0] ?? null);
  return {
    kind: "topic",
    topicId: topic.id,
    topicName: topic.name,
    roots,
    activeRoot,
    home: topic.home ?? null,
    spaceName: "",
    projectName: topic.name,
    projectPath: activeRoot ?? "",
    folderPath: activeRoot ?? "",
    branch: topic.branch,
    projectKind: "topic",
    // No session selected yet, so no account: a Topic is a set of branches,
    // and the profile arrives with the session picked inside it.
    profile: null,
  };
}

/** Where a new chat starts: a Topic's home folder, which reaches every member,
 *  or the folder git and a terminal use everywhere else. */
export function chatRoot(
  sel: Pick<Selection, "kind" | "activeRoot" | "folderPath" | "home"> | null | undefined,
): string | null {
  if (sel?.kind === "topic" && sel.home) return sel.home;
  return selectionRoot(sel);
}

// Every Topic by its home folder, so a check handed only a chat's cwd can tell
// it is a Topic chat and answer for the members.
const byHome = new Map<string, Topic>();
let notedOnce = false;

export function noteTopics(list: readonly Topic[]): void {
  notedOnce = true;
  byHome.clear();
  for (const t of list) if (t.home) byHome.set(t.home, t);
}

/** The registry filled at least once. A restore can run before the sidebar's
 *  first listing lands, and would then check a Topic chat as a plain folder. */
export async function ensureTopicsNoted(): Promise<void> {
  if (notedOnce) return;
  const list = await invoke<Topic[] | null>("list_topics").catch(() => null);
  if (!notedOnce && list) noteTopics(list);
}

export function topicAtHome(folder: string | null | undefined): Topic | null {
  return (folder && byHome.get(folder)) || null;
}

/** The root that owns `path`, longest match first so a member nested inside
 *  another still answers with itself. Null outside every root, which is what
 *  "this file belongs to no member" has to read as.
 *
 *  One rule, shared by the conflict banner, the commit target and the palette's
 *  git commands: three copies of it is how the three disagree about which repo
 *  the file in front of you is in. */
export function rootOf(path: string | null | undefined, roots: readonly string[] | null | undefined): string | null {
  if (!path || !roots?.length) return null;
  let best: string | null = null;
  for (const r of roots) {
    if (!r || !isUnderPath(path, r)) continue;
    if (!best || r.length > best.length) best = r;
  }
  return best;
}

/** What every per-workspace store keys on: `topic:<id>` for a Topic, the
 *  branch-unit folder otherwise, empty for nothing selected. */
export function workspaceKey(sel: Pick<Selection, "kind" | "topicId" | "folderPath"> | null | undefined): string {
  if (!sel) return "";
  if (sel.kind === "topic" && sel.topicId) return topicKey(sel.topicId);
  return sel.folderPath ?? "";
}

/** The folder git, settings, the watcher and a spawn run against: the active
 *  member for a Topic, the branch-unit folder otherwise. Null, never "". */
export function selectionRoot(
  sel: Pick<Selection, "kind" | "activeRoot" | "folderPath"> | null | undefined,
): string | null {
  if (!sel) return null;
  if (sel.kind === "topic") return sel.activeRoot ?? null;
  return sel.folderPath || null;
}

/** Does `folder` own a cwd for attribution: at or under it, but never under
 *  the folder's own `.tori/worktrees/`, where its Topic worktrees live and
 *  which the member folder claims by prefix instead. The same rule as the
 *  backend's `sessions::owned_by_listing`. */
export function ownsCwd(cwd: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  return isUnderPath(cwd, f) && !cwd.replace(/\/+$/, "").startsWith(`${f}/.tori/worktrees/`);
}

/** Whether a live tab counts as running under a Spaces folder: a unit tab by
 *  its workspace, a Topic or Shells tab by where it was spawned, since
 *  neither of those keys is a path. */
export function tabUnderFolder(tab: { workspace: string; cwd?: string }, folder: string): boolean {
  if (isTopicKey(tab.workspace) || isShellsKey(tab.workspace)) return !!tab.cwd && ownsCwd(tab.cwd, folder);
  return isUnderPath(tab.workspace, folder);
}
