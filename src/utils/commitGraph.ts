// Laying commits out in lanes, the way a graph view draws them.
//
// Pure, and deliberately so: it takes a page of log entries and answers with
// coordinates, which is the whole of what the drawing needs. A row's lane
// cannot be read off its position (two siblings are adjacent rows in different
// lanes) and cannot be read off its parents alone either, so the assignment is
// a walk with state: which lane is currently waiting for which sha.

import type { LogEntry } from "./gitActions";

/** A line passing through one row, from lane `from` at its top edge to lane
 *  `to` at its bottom edge. A straight line has them equal; a merge or a fork
 *  is where they differ, which is what makes the drawing bend. */
export type GraphEdge = { from: number; to: number };

export type GraphRow = {
  entry: LogEntry;
  /** The lane the commit's own dot sits in. */
  lane: number;
  /** Every line crossing this row, the dot's own included. */
  edges: GraphEdge[];
  /** More than one parent, so the dot is drawn hollow. */
  merge: boolean;
};

export type CommitGraph = {
  rows: GraphRow[];
  /** How many lanes are in use, so the caller knows how wide to be. */
  width: number;
};

/**
 * Assign lanes to a page of commits, newest first.
 *
 * The state is `waiting`: one slot per lane, holding the sha that lane expects
 * to see next, or null for a free lane. For each commit:
 *
 *   - its lane is the slot already waiting for it, or the leftmost free one
 *     (a commit nothing points at starts a new line, which is what a second
 *     branch tip looks like on the page);
 *   - every other slot waiting for the same sha is released, because two lines
 *     arriving at one commit are one line leaving it;
 *   - the first parent inherits the commit's own lane, so a straight history
 *     draws a straight line, and the remaining parents take free lanes.
 *
 * A page is a window, not a history. Parents below the last row are simply
 * never reached, and the lanes still waiting for them are what tells the caller
 * to keep drawing those lines off the bottom edge.
 */
export function buildGraph(entries: readonly LogEntry[]): CommitGraph {
  const waiting: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 0;

  const freeLane = () => {
    const at = waiting.indexOf(null);
    if (at >= 0) return at;
    waiting.push(null);
    return waiting.length - 1;
  };

  for (const entry of entries) {
    const lane = waiting.indexOf(entry.sha) >= 0 ? waiting.indexOf(entry.sha) : freeLane();
    // Lines coming into this row: every lane that was occupied above it.
    const incoming = waiting.map((sha, i) => (sha !== null || i === lane ? i : -1));

    // A second line waiting for the same commit merges into this one here.
    for (let i = 0; i < waiting.length; i += 1) {
      if (i !== lane && waiting[i] === entry.sha) waiting[i] = null;
    }

    // Where each parent continues. The first keeps this lane so ordinary
    // history is a straight vertical line.
    const parentLanes: number[] = [];
    entry.parents.forEach((parent, n) => {
      if (n === 0) {
        waiting[lane] = parent;
        parentLanes.push(lane);
        return;
      }
      // A parent already expected elsewhere is that lane, not a new one: a
      // merge of two branches that share an ancestor must not fork the drawing.
      const existing = waiting.indexOf(parent);
      const at = existing >= 0 ? existing : freeLane();
      waiting[at] = parent;
      parentLanes.push(at);
    });
    if (!entry.parents.length) waiting[lane] = null;

    const edges: GraphEdge[] = [];
    for (const i of incoming) {
      if (i < 0) continue;
      // A lane that was waiting for this commit bends into its lane; one that
      // was waiting for something else passes straight through.
      const bends = i === lane || waiting[i] === null;
      edges.push({ from: i, to: bends ? lane : i });
    }
    for (const at of parentLanes) {
      if (!edges.some((e) => e.to === at)) edges.push({ from: lane, to: at });
    }

    width = Math.max(width, waiting.length, lane + 1);
    rows.push({ entry, lane, edges, merge: entry.parents.length > 1 });
  }

  return { rows, width };
}

/** A ref name as the pill should read it: `HEAD -> main` is the current branch,
 *  and `tag: v1` is a tag, both of which git spells inside the name. */
export type RefPill = { label: string; kind: "head" | "branch" | "remote" | "tag" };

export function refPill(ref: string): RefPill {
  if (ref.startsWith("tag: ")) return { label: ref.slice(5), kind: "tag" };
  if (ref.startsWith("HEAD -> ")) return { label: ref.slice(8), kind: "head" };
  if (ref === "HEAD") return { label: ref, kind: "head" };
  // A remote-tracking ref is `<remote>/<branch>`, and the remote is a real
  // directory under refs/remotes, so the first segment is the test.
  if (ref.includes("/")) return { label: ref, kind: "remote" };
  return { label: ref, kind: "branch" };
}

export type FoldedPill = RefPill & { base: boolean };

/**
 * The pills one commit shows, both graphs drawing them the same way.
 *
 * One pill per branch: `x` and `origin/x` on one commit fold into
 * `x - origin/x`, except for HEAD, whose remote the hollow dot already speaks
 * for. A remote with no local branch keeps its own pill, and the trunk's is
 * flagged so it can wear the trunk's colour.
 */
export function foldPills(refs: readonly string[], base: string | null | undefined): FoldedPill[] {
  const all = refs.map(refPill);
  const head = all.find((p) => p.kind === "head")?.label;
  const hasLocal = (name: string) => name === head || all.some((p) => p.kind === "branch" && p.label === name);
  const remoteOf = (name: string) => all.find((p) => p.kind === "remote" && p.label.endsWith(`/${name}`));
  const isBase = (name: string) => !!base && (name === base || name === `origin/${base}`);
  return all.flatMap((p) => {
    if (p.kind === "remote" && hasLocal(p.label.slice(p.label.indexOf("/") + 1))) return [];
    const remote = p.kind === "branch" ? remoteOf(p.label) : undefined;
    const label = remote ? `${p.label} - ${remote.label}` : p.label;
    return [{ ...p, label, base: isBase(p.label) }];
  });
}

/** Initials for an author's avatar. Two words give two letters, one gives one:
 *  no network, so a circle of initials is the avatar. */
export function authorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
