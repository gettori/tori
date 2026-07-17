// Pure path-scope helpers shared by the delete-space flow.

// Is `child` the same path as, or nested under, `parent`? Trailing slashes are
// normalized; this is the same lexical prefix rule the sidebar's worktree guard
// uses (no canonicalization, since both sides come from the same discovery root).
export function isUnderPath(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}

// Exact-path equality, trailing slash normalized (unlike isUnderPath, nesting
// does not count). Used to match a session's recorded cwd against a terminal
// tab's own spawn cwd.
export function sameCwd(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

// Count sessions that are BOTH running (id present in `runningIds`) and rooted
// under `spacePath`. The prefix match (not the rendered tree nodes) is what lets
// an agent in a project subfolder be counted, matching the worktree-removal guard.
export function countRunningUnder(
  sessions: readonly { id: string; folderPath: string }[],
  runningIds: ReadonlySet<string>,
  spacePath: string,
): number {
  return sessions.filter((s) => runningIds.has(s.id) && isUnderPath(s.folderPath, spacePath)).length;
}
