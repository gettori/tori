// How the Search panel arranges its hits: per file for the list view, and per
// folder for the tree view, with single-child folder chains compressed the way
// VS Code draws them ("src/panels/Editor" as one row).

import type { SearchMatch } from "./searchOptions";

export type FileGroup = { path: string; matches: SearchMatch[] };

export type FolderNode = {
  /** Root-relative, "" for the root itself. */
  path: string;
  /** What the row shows: one segment, or a compressed chain of them. */
  name: string;
  folders: FolderNode[];
  files: FileGroup[];
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
export function folderTree(files: readonly FileGroup[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], files: [] };
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

function tidy(node: FolderNode): FolderNode {
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
export function filesUnder(node: FolderNode): FileGroup[] {
  return [...node.files, ...node.folders.flatMap(filesUnder)];
}

/** Every folder path in the tree, for Collapse All. */
export function folderPaths(node: FolderNode): string[] {
  return node.folders.flatMap((f) => [f.path, ...folderPaths(f)]);
}
