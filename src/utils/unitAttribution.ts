// Which branch-unit row a session belongs to.
//
// Worktree, plain-dir and incomplete units each own a distinct folder, so every
// session anchored there is theirs and the question does not arise. **A plain
// repo is the hard case**: all of its branch units share one `folderPath` and
// differ only by recorded branch, so the folder alone attributes nothing and
// two sibling rows would otherwise claim the same sessions.
//
// Extracted from LeftSidebar's `unitSessionsAll` because the rollup badges now
// key off the live status list rather than off a per-row session array, and
// both paths have to answer this identically. A rule that lived in one of them
// and was re-derived by the other is exactly how a session ends up badging the
// wrong branch.
//
// Two cases are easy to lose in a rewrite, so they are named here and pinned by
// tests:
//
//   * **an orphaned recorded branch** - the branch was deleted, or HEAD is
//     detached, so no visible unit matches it. The session re-homes onto the
//     fallback rather than disappearing: history is never dropped just because
//     a branch was.
//   * **a branchless session** - the transcript recorded no branch (an older
//     scan, or a session started outside a repo), and its files are whatever
//     the checkout currently is, so it parks on the fallback too.

/** The parts of a branch-unit this rule reads. */
export type AttributableUnit = { kind: string; branch: string | null; isCurrent: boolean };

/** The part of a session this rule reads. Optional because a session may have
 *  recorded no branch at all. */
export type AttributableSession = { branch?: string | null };

/** A key that tells a plain project's units apart. They share one folder, so
 *  the branch is the identity, with a sentinel for the branchless unit
 *  (detached or unborn HEAD). */
export const plainUnitKey = (u: AttributableUnit) => u.branch ?? "\0folder";

/** The plain unit that owns re-homed sessions: the current checkout, else the
 *  branchless folder fallback, else the first plain unit. */
export function fallbackHome<U extends AttributableUnit>(units: readonly U[]): U | null {
  const plain = units.filter((u) => u.kind === "plain");
  return plain.find((u) => u.isCurrent) ?? plain.find((u) => u.branch == null) ?? plain[0] ?? null;
}

/** Whether `session`, anchored in `unit`'s folder, belongs to `unit` rather
 *  than to one of its siblings. */
export function belongsToUnit(
  session: AttributableSession,
  unit: AttributableUnit,
  siblings: readonly AttributableUnit[],
): boolean {
  if (unit.kind !== "plain") return true;
  const home = fallbackHome(siblings);
  const isHome = home != null && plainUnitKey(unit) === plainUnitKey(home);
  const b = session.branch || "";
  const visible = new Set(
    siblings.filter((x) => x.kind === "plain" && x.branch).map((x) => x.branch),
  );
  if (b && visible.has(b)) return (unit.branch || "") === b;
  return isHome; // orphaned recorded branch, or a branchless session
}
