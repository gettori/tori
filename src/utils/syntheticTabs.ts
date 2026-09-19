// Editor tabs that are not files.
//
// The tab model is path-keyed all the way down: `tabId` is the path, dirty flags
// and preview choices are keyed by path, and CodeEditor's buffer map is keyed by
// path. A view like the commit graph has no file behind it, so it borrows that key
// space with a `tori://` id instead of inventing a second tab type nothing else
// understands.
//
// The id **carries its workspace**, for two reasons that are really one:
//
//   - Uniqueness. Every path-keyed map above has no workspace dimension, on the
//     grounds that "a path names exactly one file across every workspace". A
//     bare `tori://graph` would break that: two branch-units each showing their
//     own graph would collide in one key.
//   - Purging. `purgeTabsUnder` closes tabs by path prefix when a folder goes
//     away. An id with no workspace in it is under no folder, so a deleted space
//     would leave its graph tab behind, addressing a worktree that no longer exists.
//
// Everything downstream keys off `isSyntheticId`: these ids are never persisted,
// never given a buffer in `CodeEditor`, and therefore never attach a language
// server. A view may still own a CodeMirror instance privately - the editable
// search results do - which is a different thing: the pane's buffer map, its
// dirty flags and the hot-exit stash still know nothing about it.

const PREFIX = "tori://";

export type SyntheticTab = {
  /** What the tab shows: `graph`, `commit`, `history`. */
  kind: string;
  /** The kind's argument (a sha, a repo-relative file path), or "" for `graph`. */
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
 * A diff tab's id. The comparison goes in front of the path because a partially
 * staged file has two diffs open at once and they are different documents:
 * index-vs-HEAD and worktree-vs-index, each with its own hunk fingerprints.
 */
export function diffTabId(workspace: string, file: string, staged: boolean): string {
  return syntheticId("diff", workspace, `${staged ? "staged" : "unstaged"}:${file}`);
}

/** Read a diff tab's arg back. An arg with no prefix reads as unstaged, which
 *  is the mode a bare file path meant before this carried one. */
export function parseDiffArg(arg: string): { file: string; staged: boolean } {
  const at = arg.indexOf(":");
  if (at < 0) return { file: arg, staged: false };
  return { file: arg.slice(at + 1), staged: arg.slice(0, at) === "staged" };
}

/**
 * A commit-file diff's id: one file's patch within one commit, its own tab.
 * The sha goes in front of the path so two commits touching one file are two
 * tabs, the way two comparisons of a working file are.
 */
export function commitDiffTabId(workspace: string, sha: string, file: string): string {
  return syntheticId("commitdiff", workspace, `${sha}:${file}`);
}

/** Read a commit-file diff's arg back. A sha holds no colon, so the first one
 *  is the split. */
export function parseCommitDiffArg(arg: string): { sha: string; file: string } {
  const at = arg.indexOf(":");
  if (at < 0) return { sha: arg, file: "" };
  return { sha: arg.slice(0, at), file: arg.slice(at + 1) };
}

/**
 * A pull request file's diff: one file of one pull request, its own tab.
 *
 * The number goes in front of the path for the same reason a sha does on a
 * commit's file: two pull requests touching one file are two documents, with
 * their own patches, their own threads and their own draft comments.
 */
export function prDiffTabId(workspace: string, number: number, file: string): string {
  return syntheticId("prdiff", workspace, `${number}:${file}`);
}

/** Read a pull request diff's arg back. A number holds no colon, so the first
 *  one is the split. A malformed arg reads as number 0, which matches no pull
 *  request and so renders the tab's own "nothing here" rather than someone
 *  else's diff. */
export function parsePrDiffArg(arg: string): { number: number; file: string } {
  const at = arg.indexOf(":");
  if (at < 0) return { number: 0, file: "" };
  return { number: Number(arg.slice(0, at)) || 0, file: arg.slice(at + 1) };
}

/**
 * A pull request's own tab: the description, the review being written, and the
 * verdict it will be submitted with.
 *
 * One per pull request rather than per file, so the number alone is the arg.
 * The form the review is submitted from lives here and nowhere else: a summary
 * body and a verdict in every diff tab would be one piece of state with as many
 * copies as there are files open.
 */
export function prTabId(workspace: string, number: number): string {
  return syntheticId("pr", workspace, String(number));
}

/** Read a pull request tab's arg back. Anything that is not a number reads as
 *  0, which matches no pull request, so the tab draws its own "nothing here". */
export function parsePrArg(arg: string): number {
  return Number(arg) || 0;
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
  if (t.kind === "graph") return "Graph";
  if (t.kind === "shared") return "Shared in worktrees";
  // A sha is unreadable past its first few characters, and a file's history is
  // known by the file's name, not by the folders above it.
  if (t.kind === "commit") return `Commit ${t.arg.slice(0, 7)}`;
  if (t.kind === "history") return `History: ${t.arg.split("/").pop() || t.arg}`;
  // "Local" rather than "History", so the two version lists for one file are
  // told apart by the word that differs rather than by the one they share.
  if (t.kind === "localhistory") return `Local: ${t.arg.split("/").pop() || t.arg}`;
  if (t.kind === "conflict") return `Conflict: ${t.arg.split("/").pop() || t.arg}`;
  // The mode is in the label, not just the tooltip: a partially staged file has
  // two of these open and the file name alone does not tell them apart.
  if (t.kind === "diff") {
    const { file, staged } = parseDiffArg(t.arg);
    return `${file.split("/").pop() || file} (${staged ? "Staged" : "Working tree"})`;
  }
  // The number alone, because the title is not in the id and a tab that had to
  // wait for a read to be named would be blank on every restore. The strip
  // takes the title from `prTabTitle` once the store has the pull request.
  if (t.kind === "pr") return `#${parsePrArg(t.arg)}`;
  // The number rather than the mode: what tells two pull requests' copies of
  // one file apart, and the `#` is what says it is a pull request at all.
  if (t.kind === "prdiff") {
    const { number, file } = parsePrDiffArg(t.arg);
    return `${file.split("/").pop() || file} (#${number})`;
  }
  // The commit rather than the mode: a file's history tabs are told apart by
  // which commit each one is.
  if (t.kind === "commitdiff") {
    const { sha, file } = parseCommitDiffArg(t.arg);
    return `${file.split("/").pop() || file} (${sha.slice(0, 7)})`;
  }
  // `<session>:<sourceReference>:<name>` - only the name means anything to a
  // reader, and the two ids before it exist so two runs cannot share a tab.
  if (t.kind === "dapsource") return t.arg.split(":").slice(2).join(":") || "Debug source";
  // A Search Editor's arg is a sequence number; the strip shows its query
  // through `searchTabTitle` once it has one.
  if (t.kind === "search") return "Search";
  return t.arg ? `${t.kind} ${t.arg}` : t.kind;
}
