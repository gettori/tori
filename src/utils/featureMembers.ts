// One answer to "which members does this Feature have, what state is each in,
// and what colour is its chip". Three surfaces asked it separately before: the
// Toolbar's crumb chips, the sidebar's Feature rows and now the editor's file
// tree, each carrying its own copy of the Space-to-repo match.

import { createMemo, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { memberState, type Feature, type Member, type MemberStateSummary } from "./features";
import { spaceHue, spaceHueRgb } from "./spaceTint";

/** The slice of a Space a chip needs: the name and colour the hue derives from,
 *  and the project paths that say which repo belongs to it. */
export type SpaceTint = {
  name: string;
  color?: string;
  projects: { path: string }[];
};

/** The custom properties a tinted chip paints itself with. */
export type ChipStyle = { "--chip-hue": string; "--chip-rgb": string };

/** A member with everything a chip, a state badge or a tree section needs, so
 *  no consumer re-derives the Space match or reads `memberState` again. */
export type TintedMember = {
  member: Member;
  /** Stable identity: the worktree when there is one, the repo otherwise, so a
   *  member with nothing on disk is still addressable. */
  key: string;
  label: string;
  state: MemberStateSummary;
  /** The Space hue, absent for a repo outside every Space. */
  hue: string | undefined;
  style: ChipStyle | undefined;
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
  state?: MemberStateSummary;
};

/** A stored member restriction as it applies to the members present now.
 *
 *  Matched on `repoPath`, the one identity that survives a member being
 *  recreated at a different worktree path, and narrowed to the members actually
 *  here so a departed one is simply dropped. Nothing resolving falls back to
 *  every member: a saved search whose members have all left should still
 *  answer, and one that searches nothing reads as broken rather than as empty.
 *
 *  An empty result is the panel's "no restriction" value, which is why the
 *  fallback needs no separate signal. */
export function resolveMemberRestriction(
  repos: readonly string[] | undefined,
  members: readonly Pick<MemberRoot, "repoPath">[],
): string[] {
  if (!repos?.length) return [];
  const here = new Set(members.map((m) => m.repoPath));
  return repos.filter((p) => here.has(p));
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export function spaceOfMember(member: Pick<Member, "repoPath">, spaces: SpaceTint[]): SpaceTint | undefined {
  return spaces.find((g) => g.projects.some((p) => samePath(p.path, member.repoPath)));
}

export function tintedMember(member: Member, spaces: SpaceTint[]): TintedMember {
  const space = spaceOfMember(member, spaces);
  const hue = space ? spaceHue(space.name, space.color) : undefined;
  return {
    member,
    key: member.worktreePath ?? member.repoPath,
    label: member.displayName,
    state: memberState(member.state),
    hue,
    style: space && hue ? { "--chip-hue": hue, "--chip-rgb": spaceHueRgb(space.name, space.color) } : undefined,
  };
}

/** Every member of a Feature, in member order, tinted. */
export function tintedMembers(
  feature: Pick<Feature, "members"> | null | undefined,
  spaces: SpaceTint[],
): TintedMember[] {
  if (!feature) return [];
  return [...feature.members].sort((a, b) => a.order - b.order).map((m) => tintedMember(m, spaces));
}

// One generation counter and one read per generation, module-wide. The crumb,
// the sidebar rows and the editor's tree all want the same two answers on the
// same switch, and three of each is what this replaces. The listeners are never
// removed: they outlive every consumer by design, and refcounting them would
// buy nothing in a window that always has a sidebar in it.
const [tick, setTick] = createSignal(0);
let listening = false;

function watchFeatureSources(): void {
  if (listening) return;
  listening = true;
  const bump = () => setTick((n) => n + 1);
  void listen("features://changed", bump);
  void listen("config://changed", bump);
}

let reads: { tick: number; features: Promise<Feature[]>; spaces: Promise<SpaceTint[]> } | null = null;

function readAt(at: number) {
  if (!reads || reads.tick !== at) {
    reads = {
      tick: at,
      features: invoke<Feature[] | null>("list_features")
        .catch(() => null)
        .then((list) => list ?? []),
      spaces: invoke<{ spaces: SpaceTint[] } | null>("get_config")
        .catch(() => null)
        .then((cfg) => cfg?.spaces ?? []),
    };
  }
  return reads;
}

/** The live form: reads the Feature record and the Space list, and refetches on
 *  the two events that can change either. A null id fetches nothing, which is
 *  what keeps a plain worktree selection off `list_features` entirely. */
export function createFeatureMembers(featureId: () => string | null): () => TintedMember[] {
  watchFeatureSources();
  const [feature] = createResource(
    () => (featureId() ? { id: featureId()!, at: tick() } : null),
    async ({ id, at }) => (await readAt(at).features).find((f) => f.id === id) ?? null,
  );
  const [spaces] = createResource(
    () => (featureId() ? tick() : null),
    (at: number) => readAt(at).spaces,
  );
  return createMemo(() => tintedMembers(feature() ?? null, spaces() ?? []));
}
