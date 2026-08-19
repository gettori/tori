// The pane layout tree (plan phase 5). Pure data and pure edits, no Solid:
// the store persists it, the UI renders from it, and every structural change
// goes through one primitive so prune, collapse and renormalize can never be
// forgotten by a caller. Pane ids are owned by callers and never reinvented by
// an edit (a moved pane keeps its id, which is what keeps its DOM and PTY
// alive); only split nodes, which nothing outside this module addresses,
// get minted ids.

export type SplitDir = "row" | "column";

export type PaneLeaf = {
  type: "pane";
  id: string;
  /** Percent share among siblings; every sibling list renormalizes to 100. */
  size: number;
  /** A hidden pane keeps its slot and size, so re-showing restores its share. */
  hidden: boolean;
};

export type PaneSplit = {
  type: "split";
  id: string;
  dir: SplitDir;
  size: number;
  children: PaneNode[];
};

export type PaneNode = PaneLeaf | PaneSplit;

/** Max split nesting: a root split holding child splits and nothing deeper. */
export const MAX_SPLIT_DEPTH = 2;
export const MAX_PANES = 4;

/** A split id, minted from what this tree is *not* using, the way App mints a
 *  pane id. A per-run counter gave two workspaces split the same way two id
 *  sets, so the renderer rebuilt across a switch what it could have kept. */
function mintSplitId(root: PaneNode): string {
  const taken = new Set<string>();
  const collect = (n: PaneNode) => {
    if (n.type !== "split") return;
    taken.add(n.id);
    n.children.forEach(collect);
  };
  collect(root);
  let n = 1;
  while (taken.has(`split-${n}`)) n++;
  return `split-${n}`;
}

/** `next`, with every node structurally identical to its counterpart in `prev`
 *  replaced by the `prev` object. A tree is plain data, so two workspaces of one
 *  shape can render from one set of nodes and the renderer keeps them mounted. */
export function reuseNode(prev: PaneNode | undefined, next: PaneNode): PaneNode {
  if (!prev || prev === next) return next;
  if (prev.type !== next.type || prev.id !== next.id || prev.size !== next.size) return next;
  if (next.type === "pane") return (prev as PaneLeaf).hidden === next.hidden ? prev : next;
  const p = prev as PaneSplit;
  if (p.dir !== next.dir || p.children.length !== next.children.length) return next;
  const children = next.children.map((c, i) => reuseNode(p.children[i], c));
  return children.every((c, i) => c === p.children[i]) ? p : { ...next, children };
}

export type MapResult = PaneNode | PaneNode[] | null;

/**
 * The single mutation primitive. Applies `fn` to the node with `id`; the
 * result replaces it (an array splices into the parent's child list, null
 * deletes). On the way back up, a split that lost all children is pruned, a
 * split left with one child collapses into it (the child inheriting the
 * split's share), a child split running the same direction as its parent is
 * flattened into it, and sibling sizes renormalize to 100. Untouched subtrees
 * keep object identity, so a keyed renderer sees them as unchanged.
 */
export function mapNode(
  root: PaneNode,
  id: string,
  fn: (n: PaneNode) => MapResult,
): PaneNode | null {
  const r = walk(root, id, fn);
  if (r === null) return null;
  if (!Array.isArray(r)) return r;
  if (r.length === 0) return null;
  if (r.length === 1) return r[0];
  // A fragment at the root has no parent list to splice into; wrap it.
  return { type: "split", id: mintSplitId(root), dir: "row", size: 100, children: renorm(r) };
}

function walk(node: PaneNode, id: string, fn: (n: PaneNode) => MapResult): MapResult {
  if (node.id === id) return fn(node);
  if (node.type === "pane") return node;
  let changed = false;
  const out: PaneNode[] = [];
  for (const c of node.children) {
    const r = walk(c, id, fn);
    if (r === c) {
      out.push(c);
      continue;
    }
    changed = true;
    if (r === null) continue;
    if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  }
  if (!changed) return node;
  return rebuildSplit(node, out);
}

function rebuildSplit(node: PaneSplit, children: PaneNode[]): MapResult {
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0], size: node.size };
  const flat: PaneNode[] = [];
  for (const c of children) {
    if (c.type === "split" && c.dir === node.dir) {
      // A same-direction split inside its parent is the same geometry drawn
      // with an extra box; splice its children in, scaled to its share.
      for (const g of c.children) flat.push({ ...g, size: (g.size * c.size) / 100 });
    } else {
      flat.push(c);
    }
  }
  return { ...node, children: renorm(flat) };
}

function renorm(children: PaneNode[]): PaneNode[] {
  const sum = children.reduce((s, c) => s + Math.max(0, c.size), 0);
  if (sum <= 0) return children.map((c) => ({ ...c, size: 100 / children.length }));
  if (Math.abs(sum - 100) < 0.001) return children;
  return children.map((c) => ({ ...c, size: (Math.max(0, c.size) / sum) * 100 }));
}

// ---- Queries ---------------------------------------------------------------

// Sound to cache by node identity: every edit goes through mapNode, which
// rebuilds the changed path and keeps untouched subtrees, so a node object
// never changes under its cached answer. Callers copy before mutating.
const leafCache = new WeakMap<PaneNode, PaneLeaf[]>();

/** Every pane leaf, in spatial (in-order) order. */
export function leaves(root: PaneNode): PaneLeaf[] {
  const hit = leafCache.get(root);
  if (hit) return hit;
  const out: PaneLeaf[] = root.type === "pane" ? [root] : root.children.flatMap(leaves);
  leafCache.set(root, out);
  return out;
}

export const visibleLeaves = (root: PaneNode): PaneLeaf[] =>
  leaves(root).filter((l) => !l.hidden);

export const findPane = (root: PaneNode, id: string): PaneLeaf | null =>
  leaves(root).find((l) => l.id === id) ?? null;

/** Who inherits a closing pane's tabs: the pane to its right, else the one to
 *  its left (the reading order the tab-close policy already uses). */
export function neighborPane(root: PaneNode, paneId: string): string | null {
  const ls = leaves(root);
  const i = ls.findIndex((l) => l.id === paneId);
  if (i < 0) return null;
  return ls[i + 1]?.id ?? ls[i - 1]?.id ?? null;
}

/** How many splits sit above this pane (0 for a root leaf). */
function splitsAbove(root: PaneNode, id: string, depth = 0): number | null {
  if (root.type === "pane") return root.id === id ? depth : null;
  if (root.id === id) return depth;
  for (const c of root.children) {
    const d = splitsAbove(c, id, depth + 1);
    if (d !== null) return d;
  }
  return null;
}

function parentOf(root: PaneNode, id: string): PaneSplit | null {
  if (root.type === "pane") return null;
  if (root.children.some((c) => c.id === id)) return root;
  for (const c of root.children) {
    const p = parentOf(c, id);
    if (p) return p;
  }
  return null;
}

// ---- Edits -----------------------------------------------------------------
// Each returns the new root, or null for "refused": the caller keeps the tree
// it has. Refusal is a return value rather than a throw because every refusal
// here is an expected outcome (a cap, a guard), not a bug.

/** Split `paneId`, placing `newLeaf` on the `pos` side of it (after by default;
 *  a drop on a pane's left or top edge is what asks for before). A split in the
 *  direction the parent already runs inserts a sibling; a cross split nests, and
 *  nesting is where the depth cap bites. */
export function splitPane(
  root: PaneNode,
  paneId: string,
  dir: SplitDir,
  newLeaf: PaneLeaf,
  pos: "before" | "after" = "after",
): PaneNode | null {
  if (!findPane(root, paneId)) return null;
  if (leaves(root).some((l) => l.id === newLeaf.id)) return null;
  if (leaves(root).length >= MAX_PANES) return null;
  const order = (target: PaneNode, added: PaneNode) =>
    pos === "before" ? [added, target] : [target, added];
  const parent = parentOf(root, paneId);
  if (parent && parent.dir === dir) {
    return mapNode(root, paneId, (t) =>
      order({ ...(t as PaneLeaf), size: t.size / 2 }, { ...newLeaf, size: t.size / 2 }),
    );
  }
  const above = splitsAbove(root, paneId) ?? 0;
  if (above >= MAX_SPLIT_DEPTH) return null;
  return mapNode(root, paneId, (t) => ({
    type: "split",
    id: mintSplitId(root),
    dir,
    size: t.size,
    children: order({ ...(t as PaneLeaf), size: 50 }, { ...newLeaf, size: 50 }),
  }));
}

/** Remove a pane. The last pane is un-removable. */
export function closePane(root: PaneNode, paneId: string): PaneNode | null {
  if (!findPane(root, paneId)) return null;
  if (leaves(root).length === 1) return null;
  return mapNode(root, paneId, () => null);
}

/** Move a pane next to another, as its sibling. Ids travel with the pane. */
export function movePane(
  root: PaneNode,
  paneId: string,
  targetPaneId: string,
  pos: "before" | "after",
): PaneNode | null {
  if (paneId === targetPaneId) return null;
  const moved = findPane(root, paneId);
  if (!moved || !findPane(root, targetPaneId)) return null;
  const without = mapNode(root, paneId, () => null);
  if (!without) return null;
  return mapNode(without, targetPaneId, (t) => {
    const half = t.size / 2;
    const m = { ...moved, size: half };
    const target = { ...t, size: half };
    return pos === "before" ? [m, target] : [target, m];
  });
}

/** Hide or show a pane. Hiding the last visible pane is refused: an all-hidden
 *  layout has no surface left to act on and no button left to undo it with. */
export function setPaneHidden(root: PaneNode, paneId: string, hidden: boolean): PaneNode | null {
  const pane = findPane(root, paneId);
  if (!pane) return null;
  if (pane.hidden === hidden) return root;
  if (hidden && visibleLeaves(root).every((l) => l.id === paneId)) return null;
  return mapNode(root, paneId, (t) => ({ ...(t as PaneLeaf), hidden }));
}

/** Give a pane `size` percent of its sibling row, siblings scaling to fill the
 *  rest in proportion to what they had. A root leaf has no siblings to trade
 *  with, so it comes back unchanged. */
export function resizePane(root: PaneNode, paneId: string, size: number): PaneNode | null {
  if (!findPane(root, paneId)) return null;
  const parent = parentOf(root, paneId);
  if (!parent) return root;
  const clamped = Math.min(99, Math.max(1, size));
  return mapNode(root, parent.id, (p) => {
    const split = p as PaneSplit;
    const rest = split.children.filter((c) => c.id !== paneId);
    const restSum = rest.reduce((s, c) => s + Math.max(0, c.size), 0);
    const remaining = 100 - clamped;
    return {
      ...split,
      children: split.children.map((c) =>
        c.id === paneId
          ? { ...c, size: clamped }
          : { ...c, size: restSum > 0 ? (Math.max(0, c.size) / restSum) * remaining : remaining / rest.length },
      ),
    };
  });
}

// ---- Focus policy ----------------------------------------------------------

/**
 * Where a kind opens when nothing decides otherwise (plan phase 11), resolved
 * spatially at call time: a rule names an end of the tree, not a pane, so it
 * still answers after a split, a close or a move. Kinds are plain strings here
 * so the layout layer never imports the tab layer, and the rules are passed in
 * so this stays pure.
 *
 * A pane locked to this kind outranks the side rule, and a pane locked to
 * another kind is skipped. If every pane is locked away, the side's own end
 * answers anyway: a lock is a routing preference here, and refusing to place a
 * tab at all would leave it nowhere.
 *
 * Hidden panes count. That is what makes the terminal and editor toggles work:
 * the pane a kind opens into is the one the toggle reveals, and dropping it
 * from the search would open the tab somewhere else and leave the toggle
 * pointing at an empty box.
 */
export function resolvePinPane(
  root: PaneNode,
  kind: string,
  rules?: { side?: "leftmost" | "rightmost"; locks?: Record<string, string> },
): PaneLeaf | null {
  const ls = leaves(root);
  if (ls.length === 0) return null;
  const locks = rules?.locks ?? {};
  const ordered = (rules?.side ?? (kind === "file" ? "rightmost" : "leftmost")) === "rightmost"
    ? [...ls].reverse()
    : ls;
  return (
    ordered.find((l) => locks[l.id] === kind) ??
    ordered.find((l) => !locks[l.id]) ??
    ordered[0]
  );
}

/** The pane a kind toggle acts on: the pane of the most recently focused
 *  matching tab, or the pin default when no tab of that kind exists. */
export function resolveTogglePane(
  root: PaneNode,
  matches: { paneId: string; stamp: number }[],
  kind: string,
): string | null {
  const live = matches.filter((m) => findPane(root, m.paneId));
  if (live.length === 0) return resolvePinPane(root, kind)?.id ?? null;
  return live.reduce((a, b) => (b.stamp > a.stamp ? b : a)).paneId;
}

/** Which tab takes over when `closedId` closes: the right neighbor, then the
 *  left. Null when the closed tab was alone (or not in the list at all). */
export function nextActiveAfterClose(ids: string[], closedId: string): string | null {
  const i = ids.indexOf(closedId);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}
