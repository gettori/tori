// One answer to "which members does this Topic have, what state is each in,
// and what colour is its chip". Three surfaces asked it separately before: the
// Toolbar's crumb chips, the sidebar's Topic rows and now the editor's file
// tree, each carrying its own copy of the Space-to-repo match.

import { createMemo, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { memberRoot, memberState, rootOf, type Member, type MemberStateSummary, type Topic } from "./topics";
import { spaceHue, spaceHueRgb } from "./spaceTint";
import { isSyntheticId } from "./syntheticTabs";
import type { ProjectIconSource } from "../components/Icon/ProjectIcon";

/** The slice of a project a member needs: the path that says which repo belongs
 *  to which Space, the name Docs looks its folder up by, the branch units that
 *  say how this repo's worktrees are laid out, and the icon its chip wears. */
export type SpaceProject = Pick<ProjectIconSource, "icon" | "iconFile" | "favicon"> & {
  name?: string;
  path: string;
  /** `kind` is "worktree" | "plain" | "plain-dir" | "incomplete", typed as the
   *  string the wire carries so a `get_config` payload assigns without a cast. */
  branchUnits?: { folderPath: string; kind: string }[];
};

/** The slice of a Space a chip needs: the name and colour the hue derives from,
 *  and the projects that say which repo belongs to it. */
export type SpaceTint = {
  name: string;
  color?: string;
  projects: SpaceProject[];
};

/** The custom properties a tinted chip paints itself with. */
export type ChipStyle = { "--chip-hue": string; "--chip-rgb": string };

/** A member with everything a chip, a state badge or a tree section needs, so
 *  no consumer re-derives the Space match or reads `memberState` again. */
export type TintedMember = {
  member: Member;
  /** Stable identity: the worktree or the reference's checkout when there is
   *  one, the repo otherwise, so a member with nothing on disk is still
   *  addressable. */
  key: string;
  /** The folder the member opens as, null while it cannot be opened. */
  root: string | null;
  label: string;
  state: MemberStateSummary;
  /** The Space hue, absent for a repo outside every Space. */
  hue: string | undefined;
  style: ChipStyle | undefined;
  /** The project's icon, seeded on the repo path as the sidebar's project row
   *  is, so a project with no icon of its own derives the same glyph in both. */
  icon: ProjectIconSource;
  /** How this member's *repo* is laid out, which is what says whether it has a
   *  `.shared/` folder to offer. See `projectUnitKind`. */
  kind: string | undefined;
};

/** One member root, as the surfaces that draw a section per member take it.
 *
 *  `path` is the worktree folder, or the repo folder for a member that has no
 *  worktree yet: it identifies the section and is what a repair action hands
 *  back. It is deliberately **not** an identity to persist, because a Recreate
 *  moves it. `repoPath` is the one field that survives recreate, relocate and a
 *  missing worktree, so anything stored across sessions keys on that.
 *
 *  `label` and `tint` name the member and are shown only alongside other roots;
 *  `state` marks a member that cannot be opened. */
export type MemberRoot = {
  path: string;
  repoPath: string;
  label: string;
  /** The member's Space colour, painted on its chip. */
  tint?: string;
  /** The project's icon. Absent draws the glyph derived from `repoPath`. */
  icon?: ProjectIconSource;
  state?: MemberStateSummary;
  /** A reference member: the user's own checkout, which Tori reads and never
   *  stages, commits, discards or pushes in. */
  readOnly?: boolean;
};

/** One member's worth of rows, or the trailing bucket of rows under no member. */
export type MemberGroup<T> = {
  /** The member these rows belong to, null for the trailing bucket. */
  root: MemberRoot | null;
  items: T[];
};

/** What the trailing bucket is called wherever it is drawn. */
export const OUTSIDE_MEMBERS_LABEL = "Outside this Topic";

/**
 * Rows split into one group per member, in member order, plus a trailing group
 * for anything under none of them.
 *
 * A row under no member is kept rather than dropped: removing a repository from
 * a Topic keeps its worktree by default, so the marks and diagnostics that
 * point into it are still about files on disk. Silently sweeping them would
 * destroy hand-made marks for a folder that is still there.
 *
 * Every member gets a group even when it has no rows, the way the tree and the
 * Search panel draw a section per member: an empty section under a member that
 * cannot be opened is the only place that says why it is empty.
 *
 * The match itself is `rootOf`'s longest-wins rule, so a member nested inside
 * another answers with itself and no two surfaces can disagree.
 */
export function groupByMemberRoot<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  roots: readonly MemberRoot[],
): MemberGroup<T>[] {
  const buckets: T[][] = roots.map(() => []);
  // First index wins, so two members sharing a path cannot double-count a row.
  const at = new Map<string, number>();
  roots.forEach((r, i) => {
    if (!at.has(r.path)) at.set(r.path, i);
  });
  const paths = [...at.keys()];
  const outside: T[] = [];
  for (const item of items) {
    const root = rootOf(pathOf(item), paths);
    const i = root != null ? at.get(root) : undefined;
    if (i != null) buckets[i].push(item);
    else outside.push(item);
  }
  const groups: MemberGroup<T>[] = roots.map((root, i) => ({ root, items: buckets[i] }));
  if (outside.length) groups.push({ root: null, items: outside });
  return groups;
}

/**
 * How many member chips a capped row shows before the rest collapse into `+N`.
 *
 * Two surfaces cap: the sidebar's collapsed Topic row and the right panel's
 * chip row. A list with per-member *actions* never caps, because a member no
 * chip can reach is a member whose rename, reorder and repair are unreachable
 * with it.
 */
export const CHIP_CAP = 6;

/** Whether a per-member surface draws its headers. Alongside other members it
 *  has to; alone it does not, unless that one member cannot be opened, in which
 *  case the header carries the only account of why there is nothing below it. */
export function memberSectionsHeaded(roots: readonly MemberRoot[] | null | undefined): boolean {
  if (!roots?.length) return false;
  return roots.length > 1 || roots.some((r) => r.state?.usable === false);
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export function spaceOfMember(member: Pick<Member, "repoPath">, spaces: SpaceTint[]): SpaceTint | undefined {
  return projectOfMember(member, spaces)?.space;
}

/** The Space and project a member's repo was discovered as. A member's
 *  `repoPath` *is* the project path (that is what the Space match has always
 *  compared), so one find answers both. */
export function projectOfMember(
  member: Pick<Member, "repoPath">,
  spaces: SpaceTint[],
): { space: SpaceTint; project: SpaceProject } | undefined {
  for (const space of spaces) {
    const project = space.projects.find((p) => samePath(p.path, member.repoPath));
    if (project) return { space, project };
  }
  return undefined;
}

/**
 * How a project is laid out, from the unit whose folder *is* the project.
 *
 * Matched on `folderPath`, never taken from `branchUnits[0]`. A plain repo
 * carries a unit per attached branch, all rooted at the repo folder itself, and
 * since #158 it also lists the Topic worktrees inside it, each with
 * `kind: "worktree"`. So position says nothing, and matching the *member's*
 * worktree would answer `worktree` for a Topic worktree in a plain repo.
 *
 * A bare container has no unit at its own folder: every unit is a worktree
 * beside it. That is exactly the layout `.shared/` belongs to, which is what
 * the answer is used for.
 */
export function projectUnitKind(project: SpaceProject | undefined): string | undefined {
  if (!project?.branchUnits?.length) return undefined;
  const { path, branchUnits } = project;
  return branchUnits.find((u) => samePath(u.folderPath, path))?.kind ?? "worktree";
}

export function tintedMember(member: Member, spaces: SpaceTint[]): TintedMember {
  const found = projectOfMember(member, spaces);
  const space = found?.space;
  const project = found?.project;
  const hue = space ? spaceHue(space.name, space.color) : undefined;
  return {
    member,
    key: memberFolder(member) ?? member.repoPath,
    root: memberRoot(member),
    label: member.displayName,
    state: memberState(member.state),
    hue,
    style: space && hue ? { "--chip-hue": hue, "--chip-rgb": spaceHueRgb(space.name, space.color) } : undefined,
    icon: { seed: member.repoPath, icon: project?.icon, iconFile: project?.iconFile, favicon: project?.favicon },
    kind: projectUnitKind(project),
  };
}

/** The folder a member reads or writes, whether or not it is there right now:
 *  a tab stays open when its worktree goes missing. */
function memberFolder(member: Member): string | null {
  return member.worktreePath ?? member.checkout?.path ?? null;
}

/** Every member of a Topic, in member order, tinted. */
export function tintedMembers(topic: Pick<Topic, "members"> | null | undefined, spaces: SpaceTint[]): TintedMember[] {
  if (!topic) return [];
  return [...topic.members].sort((a, b) => a.order - b.order).map((m) => tintedMember(m, spaces));
}

/**
 * Which member a file belongs to, for a surface that has to name its repo.
 *
 * Over every member, not over `Selection.roots`, which holds only present ones:
 * a tab stays open when its worktree goes missing, and that is exactly when
 * losing the chip would read as "this file belongs to no repo".
 *
 * The longest-match rule itself is `rootOf`'s, so a member nested inside another
 * still answers with itself and the two cannot disagree.
 */
export function memberFor(
  path: string | null | undefined,
  members: readonly TintedMember[] | null | undefined,
): TintedMember | null {
  if (!path || !members?.length) return null;
  const byRoot = new Map<string, TintedMember>();
  for (const m of members) {
    const folder = memberFolder(m.member);
    if (folder) byRoot.set(folder, m);
  }
  const root = rootOf(path, [...byRoot.keys()]);
  return root ? (byRoot.get(root) ?? null) : null;
}

/**
 * The member root a surface that follows the file in front should use.
 *
 * Four ways the answer is not the active tab's member, and all four fall back
 * to the workspace's own active root: nothing open, a synthetic view (which
 * belongs to the workspace rather than to any one repo in it), a path under no
 * member, and a selection that is not a Topic at all, which has no members
 * for a path to be in.
 *
 * The fallback is `activeRoot` rather than nothing, because Debug, Session,
 * Outline and Calls all have to name *a* repo: with the tree focused and no tab
 * open, the one you last worked in is the only honest answer.
 */
export function focusMemberRoot(
  path: string | null | undefined,
  members: readonly TintedMember[] | null | undefined,
  activeRoot: string | null,
): string | null {
  if (!path || isSyntheticId(path)) return activeRoot;
  return memberFor(path, members)?.key ?? activeRoot;
}

// One generation counter and one read per generation, module-wide. The crumb,
// the sidebar rows and the editor's tree all want the same two answers on the
// same switch, and three of each is what this replaces. The listeners are never
// removed: they outlive every consumer by design, and refcounting them would
// buy nothing in a window that always has a sidebar in it.
const [tick, setTick] = createSignal(0);
let listening = false;

function watchTopicSources(): void {
  if (listening) return;
  listening = true;
  const bump = () => setTick((n) => n + 1);
  void listen("topics://changed", bump);
  void listen("config://changed", bump);
}

let reads: { tick: number; topics: Promise<Topic[]>; spaces: Promise<SpaceTint[]> } | null = null;

function readAt(at: number) {
  if (!reads || reads.tick !== at) {
    reads = {
      tick: at,
      topics: invoke<Topic[] | null>("list_topics")
        .catch(() => null)
        .then((list) => list ?? []),
      spaces: invoke<{ spaces: SpaceTint[] } | null>("get_config")
        .catch(() => null)
        .then((cfg) => cfg?.spaces ?? []),
    };
  }
  return reads;
}

/** The live form: reads the Topic record and the Space list, and refetches on
 *  the two events that can change either. A null id fetches nothing, which is
 *  what keeps a plain worktree selection off `list_topics` entirely. */
export function createTopicMembers(topicId: () => string | null): () => TintedMember[] {
  watchTopicSources();
  const [topic] = createResource(
    () => (topicId() ? { id: topicId()!, at: tick() } : null),
    async ({ id, at }) => (await readAt(at).topics).find((f) => f.id === id) ?? null,
  );
  const [spaces] = createResource(
    () => (topicId() ? tick() : null),
    (at: number) => readAt(at).spaces,
  );
  return createMemo(() => tintedMembers(topic() ?? null, spaces() ?? []));
}
