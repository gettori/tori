// Fan-out attempts, as the tree reads them.
//
// The backend (`src-tauri/src/attempts.rs`) records only what git cannot say:
// which group an attempt belongs to and what that group was trying to do. Two
// consequences shape this module.
//
//   * **The recorded map decides what is an attempt, never the directory name.**
//     An attempt's worktree lives under a dot-directory inside the project root,
//     but matching on that name here would mean the frontend inventing its own
//     copy of a backend constant. It would also change the meaning of an
//     unrecorded leftover, which `attempts.rs` deliberately lets surface as an
//     ordinary worktree ("recoverable"), into an invisible one.
//   * **An attempt may or may not already be a branch-unit.** A worktree
//     container enumerates its worktrees, so its attempts arrive as ordinary
//     units that must be lifted out of the flat list. A plain repo enumerates
//     *branches*, so its attempts are not in the list at all and the caller has
//     to synthesize a unit from the record. Both are normal, which is why
//     `unit` is optional rather than an error case.

/// One attempt as the backend records it (`Attempt`, camelCase over IPC).
export type AttemptRecord = {
  path: string;
  groupId: string;
  goal: string;
};

/// The shape this module needs from a branch-unit: where it points. Kept
/// structural so the grouping stays testable without the sidebar's full unit.
export type UnitLike = { folderPath: string };

export type AttemptMember<U extends UnitLike> = {
  attempt: AttemptRecord;
  /// The branch-unit git already reported for this path, when there is one.
  unit: U | undefined;
};

export type AttemptGroup<U extends UnitLike> = {
  groupId: string;
  goal: string;
  members: AttemptMember<U>[];
};

/// Compare two absolute paths as the same location.
///
/// Both sides are absolute and machine-produced (git's worktree listing on one,
/// a recorded path on the other), so this normalizes only the two ways they
/// legitimately differ: a trailing slash, and macOS's `/private` prefix on the
/// symlinked temp roots that tests and `$TMPDIR` live under.
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.startsWith("/private/") ? trimmed.slice("/private".length) : trimmed;
}

/**
 * Split a project's branch-units into the ones the tree renders flat and the
 * attempt groups it renders as a group each.
 *
 * Group order follows first appearance in `attempts` (the map's own order, so
 * creation order), and members keep their order within a group. A group is
 * never dropped for having no matching unit: on a plain repo that is every
 * group, and rendering nothing there would hide the attempts entirely.
 */
export function groupAttempts<U extends UnitLike>(
  units: readonly U[],
  attempts: readonly AttemptRecord[],
): { units: U[]; groups: AttemptGroup<U>[] } {
  if (attempts.length === 0) return { units: [...units], groups: [] };

  const ordinary = units.filter((u) => !attempts.some((a) => samePath(a.path, u.folderPath)));

  const groups: AttemptGroup<U>[] = [];
  const byId = new Map<string, AttemptGroup<U>>();
  for (const attempt of attempts) {
    let group = byId.get(attempt.groupId);
    if (!group) {
      // The goal is recorded per attempt but is a property of the group; the
      // first member's is the group's, so a hand-edited map cannot make the
      // header flicker between two texts.
      group = { groupId: attempt.groupId, goal: attempt.goal, members: [] };
      byId.set(attempt.groupId, group);
      groups.push(group);
    }
    group.members.push({
      attempt,
      unit: units.find((u) => samePath(attempt.path, u.folderPath)),
    });
  }
  return { units: ordinary, groups };
}

/// The last path segment, which is the attempt's folder name. Used as the label
/// (and branch guess) for an attempt with no branch-unit of its own, where the
/// folder is all the record carries.
export function attemptFolderName(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() ?? path;
}
