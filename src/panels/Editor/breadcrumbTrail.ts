// The trail above the editor: where this file sits, and where the caret sits
// inside it.
//
// Two independent chains that read as one line. The path half is lexical and is
// always available; the symbol half needs a language server and is empty without
// one. Keeping them separate is what lets the bar render for a plain text file
// in a project with no server at all, which is the common case and would
// otherwise be a blank strip.
//
// Pure, and its own file for `closedBuffers.ts`'s reason: containment arithmetic
// has several ways to be off by one and none of them need a mounted pane to
// catch.

import type { SymbolNode } from "../../utils/symbols";

/**
 * A step in the path half.
 *
 * `path` is absolute, so a crumb is enough on its own to open a picker or a
 * file; nothing has to re-join it with the root. `isDir` is what says whether
 * the crumb *is* the folder to list or merely lives in one.
 */
export type PathCrumb = { name: string; path: string; isDir: boolean };

/** The member a trail starts at, inside a Feature: the folder the file actually
 *  sits under, and the name that folder wears in the bar. */
export type CrumbMember = { root: string; label: string };

/** The folder holding `path`. A path directly under `/` gives `/`, so this
 *  never returns the empty string and a caller can always list what it gets. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** The last segment, which is the name the tab strip shows. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * The file's place in the workspace, outermost folder first.
 *
 * Relative to the root rather than absolute: the workspace is already named in
 * the sidebar, and repeating `/Users/…/space/proj/main` in front of every file
 * would push the part that varies off the right edge.
 *
 * A path that is not under the root gets a single crumb naming the file itself.
 * That covers a Docs-tree file and anything opened from outside the project: the
 * trail cannot say where it sits relative to a root it does not share, but it
 * can still offer its own folder, which is the crumb people actually click.
 *
 * Inside a Feature the member is what the file sits under, and it need not be
 * the active one: resolving a background member's file against the active root
 * would find no shared prefix and collapse the whole trail to a basename.
 */
export function pathCrumbs(
  root: string | null,
  path: string | null,
  member?: CrumbMember | null,
): PathCrumb[] {
  if (!path) return [];
  // Only a member that really holds the file replaces the root, so a mismatched
  // one costs its own crumb rather than the whole trail.
  const held = member && path.startsWith(`${member.root}/`) ? member : null;
  const base = held?.root ?? root;
  const under = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
  if (under === null) return [{ name: baseName(path), path, isDir: false }];
  const names = under.split("/").filter(Boolean);
  // The member crumb is the one place the trail does name its root: it is what
  // says which repo, and it is the only root a Feature has more than one of.
  const out: PathCrumb[] = held ? [{ name: held.label, path: held.root, isDir: true }] : [];
  let at = base!;
  for (let i = 0; i < names.length; i++) {
    at = `${at}/${names[i]}`;
    out.push({ name: names[i], path: at, isDir: i < names.length - 1 });
  }
  return out;
}

/** Whether `node`'s extent holds the caret. Line *and* column: a minified file
 *  or a one-line object literal has every symbol starting and ending on line 1,
 *  and a line-only test would call all of them enclosing. */
function holds(node: SymbolNode, line: number, column: number): boolean {
  const startsAtOrBefore = node.line < line || (node.line === line && node.column <= column);
  const endsAtOrAfter = node.endLine > line || (node.endLine === line && node.endColumn >= column);
  return startsAtOrBefore && endsAtOrAfter;
}

/**
 * The symbols enclosing the caret, outermost first.
 *
 * Descends the tree rather than scanning it flat, because the flat answer would
 * have to reconstruct which hit is inside which, and the tree already says so:
 * a node's children are the only candidates once the node itself holds the
 * caret.
 *
 * The first holding sibling wins. Ranges from a conformant server do not
 * overlap, and when a broken one sends overlapping ranges the first in document
 * order is the better guess than the last.
 *
 * Empty is the ordinary answer, not an error: a caret between two functions is
 * inside neither, and so is every caret in a file whose server offers no
 * symbols.
 */
export function symbolTrail(
  nodes: readonly SymbolNode[],
  line: number,
  column: number,
): SymbolNode[] {
  const out: SymbolNode[] = [];
  let level: readonly SymbolNode[] = nodes;
  for (;;) {
    const hit = level.find((n) => holds(n, line, column));
    if (!hit) return out;
    out.push(hit);
    level = hit.children;
  }
}

/**
 * The symbols a trail crumb could have been instead: its own siblings.
 *
 * Depth 0 is the file's top level; deeper is the children of the crumb before
 * it. Reads off the trail rather than re-walking the tree, so the picker can
 * never offer a set the bar did not come from.
 */
export function siblingsAt(
  nodes: readonly SymbolNode[],
  trail: readonly SymbolNode[],
  depth: number,
): readonly SymbolNode[] {
  return depth === 0 ? nodes : (trail[depth - 1]?.children ?? []);
}
