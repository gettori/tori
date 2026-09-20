// Paths as a folder tree, for the two panels that draw one over something
// other than the filesystem: Search over its hits, and Pull requests over the
// files a pull request changed. Single-child folder chains are compressed the
// way VS Code draws them ("src/panels/Editor" as one row).
//
// Generic over what hangs off a leaf, since the two carry different things
// there: a file's matches on one side, the file's own status and counts on the
// other.

import type { SearchMatch } from "./searchOptions";

export type FileGroup = { path: string; matches: SearchMatch[] };

/** A leaf: anything that names one root-relative file. */
export type Pathed = { path: string };

export type FolderNode<T extends Pathed = FileGroup> = {
  /** Root-relative, "" for the root itself. */
  path: string;
  /** What the row shows: one segment, or a compressed chain of them. */
  name: string;
  folders: FolderNode<T>[];
  files: T[];
};

/** Matches by file, in the order files were first seen. */
export function groupByFile(matches: readonly SearchMatch[]): FileGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    let list = byPath.get(m.path);
    if (!list) {
      order.push(m.path);
      byPath.set(m.path, (list = []));
    }
    list.push(m);
  }
  return order.map((path) => ({ path, matches: byPath.get(path)! }));
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The files as a folder tree: folders first, then files, each by name. */
export function folderTree<T extends Pathed>(files: readonly T[]): FolderNode<T> {
  const root: FolderNode<T> = { path: "", name: "", folders: [], files: [] };
  for (const f of files) {
    let at = root;
    const dir = dirName(f.path);
    for (const seg of dir ? dir.split("/") : []) {
      const path = at.path ? `${at.path}/${seg}` : seg;
      let next = at.folders.find((c) => c.path === path);
      if (!next) at.folders.push((next = { path, name: seg, folders: [], files: [] }));
      at = next;
    }
    at.files.push(f);
  }
  return tidy(root);
}

function tidy<T extends Pathed>(node: FolderNode<T>): FolderNode<T> {
  let n = node;
  while (n.path && !n.files.length && n.folders.length === 1) {
    const only = n.folders[0];
    n = { ...only, name: `${n.name}/${only.name}` };
  }
  return {
    ...n,
    folders: n.folders.map(tidy).sort((a, b) => a.name.localeCompare(b.name)),
    files: [...n.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path))),
  };
}

/** Every file under a folder node, nested ones included. */
export function filesUnder<T extends Pathed>(node: FolderNode<T>): T[] {
  return [...node.files, ...node.folders.flatMap(filesUnder)];
}

/** Every folder path in the tree, for Collapse All. */
export function folderPaths<T extends Pathed>(node: FolderNode<T>): string[] {
  return node.folders.flatMap((f) => [f.path, ...folderPaths(f)]);
}
