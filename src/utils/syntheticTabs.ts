// Editor tabs that are not files.
//
// The tab model is path-keyed all the way down: `tabId` is the path, dirty flags
// and preview choices are keyed by path, and CodeEditor's buffer map is keyed by
// path. A view like the commit log has no file behind it, so it borrows that key
// space with a `sway://` id instead of inventing a second tab type nothing else
// understands.
//
// The id **carries its workspace**, for two reasons that are really one:
//
//   - Uniqueness. Every path-keyed map above has no workspace dimension, on the
//     grounds that "a path names exactly one file across every workspace". A
//     bare `sway://log` would break that: two branch-units each showing their
//     own log would collide in one key.
//   - Purging. `purgeTabsUnder` closes tabs by path prefix when a folder goes
//     away. An id with no workspace in it is under no folder, so a deleted space
//     would leave its log tab behind, addressing a worktree that no longer exists.
//
// Everything downstream keys off `isSyntheticId`: these ids are never persisted,
// never given a CodeMirror buffer, and therefore never attach a language server.

const PREFIX = "sway://";

export type SyntheticTab = {
  /** What the tab shows: `log`, `commit`, `history`. */
  kind: string;
  /** The kind's argument (a sha, a repo-relative file path), or "" for `log`. */
  arg: string;
  /** Absolute path of the branch-unit folder this tab belongs to. */
  workspace: string;
};

/** Is this tab id a synthetic view rather than a file on disk? */
export function isSyntheticId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/**
 * Build the id for one synthetic view. Both the argument and the workspace are
 * percent-encoded, so a path containing `?` or `/` cannot be read back as a
 * different field.
 */
export function syntheticId(kind: string, workspace: string, arg = ""): string {
  const head = arg ? `${kind}/${encodeURIComponent(arg)}` : kind;
  return `${PREFIX}${head}?ws=${encodeURIComponent(workspace)}`;
}

/** Read an id back, or null when it is a file path or does not parse. */
export function parseSyntheticId(id: string): SyntheticTab | null {
  if (!isSyntheticId(id)) return null;
  const rest = id.slice(PREFIX.length);
  const q = rest.indexOf("?ws=");
  if (q < 0) return null;
  try {
    const workspace = decodeURIComponent(rest.slice(q + "?ws=".length));
    const [kind, ...tail] = rest.slice(0, q).split("/");
    if (!kind || !workspace) return null;
    return { kind, arg: tail.length ? decodeURIComponent(tail.join("/")) : "", workspace };
  } catch {
    // A malformed escape. Treated as unparseable rather than thrown, because
    // this runs over ids from storage and from other panels.
    return null;
  }
}

/**
 * The path a tab is scoped to, for the folder-prefix sweeps: a synthetic tab
 * answers with its workspace, a file tab with its own path.
 *
 * An id we cannot parse answers with itself, so it is scoped to nothing and
 * survives. That is the safe direction (a purge is destructive and skips no
 * dirty prompt), and unreachable in practice: every synthetic id is built by
 * `syntheticId` above.
 */
export function tabScopePath(id: string): string {
  return parseSyntheticId(id)?.workspace ?? id;
}

/**
 * Tab-strip label for a synthetic id. A tab is a few characters wide, so the
 * label carries the shortest thing that distinguishes this tab from its
 * siblings; the tooltip (see `tabTitle` in Editor) carries the workspace, and
 * the view's own header carries everything else.
 */
export function syntheticTabName(id: string): string {
  const t = parseSyntheticId(id);
  if (!t) return id;
  if (t.kind === "log") return "Commit log";
  // A sha is unreadable past its first few characters, and a file's history is
  // known by the file's name, not by the folders above it.
  if (t.kind === "commit") return `Commit ${t.arg.slice(0, 7)}`;
  if (t.kind === "history") return `History: ${t.arg.split("/").pop() || t.arg}`;
  if (t.kind === "conflict") return `Conflict: ${t.arg.split("/").pop() || t.arg}`;
  return t.arg ? `${t.kind} ${t.arg}` : t.kind;
}
