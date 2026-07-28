import { describe, expect, it } from "vitest";
import { attemptFolderName, groupAttempts, samePath, type AttemptRecord } from "./attempts";

type Unit = { folderPath: string; label: string };

const unit = (folderPath: string, label: string): Unit => ({ folderPath, label });
const attempt = (path: string, groupId: string, goal = "make the parser faster"): AttemptRecord => ({
  path,
  groupId,
  goal,
});

// The whole point of fan-out is that three attempts read as one question with
// three answers rather than as three unrelated worktrees, so the grouping is
// asserted from both directions: the group is whole, and the ordinary worktree
// beside it is untouched.
describe("groupAttempts", () => {
  it("renders three attempts as one group and leaves an ordinary worktree alone", () => {
    const units = [
      unit("/repo/main", "main"),
      unit("/repo/.sway-attempts/try-1", "try-1"),
      unit("/repo/.sway-attempts/try-2", "try-2"),
      unit("/repo/.sway-attempts/try-3", "try-3"),
    ];
    const attempts = [
      attempt("/repo/.sway-attempts/try-1", "g1"),
      attempt("/repo/.sway-attempts/try-2", "g1"),
      attempt("/repo/.sway-attempts/try-3", "g1"),
    ];

    const { units: ordinary, groups } = groupAttempts(units, attempts);

    expect(ordinary.map((u) => u.label)).toEqual(["main"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].goal).toBe("make the parser faster");
    expect(groups[0].members.map((m) => m.unit?.label)).toEqual(["try-1", "try-2", "try-3"]);
  });

  it("keeps two groups apart, in the order they were created", () => {
    const attempts = [
      attempt("/repo/.sway-attempts/a", "g1", "first question"),
      attempt("/repo/.sway-attempts/b", "g2", "second question"),
      attempt("/repo/.sway-attempts/c", "g1", "first question"),
    ];

    const { groups } = groupAttempts([], attempts);

    expect(groups.map((g) => g.groupId)).toEqual(["g1", "g2"]);
    expect(groups[0].members).toHaveLength(2);
    expect(groups[1].members).toHaveLength(1);
  });

  // A plain repo's units are its branches, so its attempts never appear among
  // them. The group still has to render, or fanning out on a plain repo would
  // create three worktrees the tree never shows.
  it("groups attempts that have no branch-unit of their own", () => {
    const { units: ordinary, groups } = groupAttempts(
      [unit("/repo", "main")],
      [attempt("/repo/.sway-attempts/try-1", "g1"), attempt("/repo/.sway-attempts/try-2", "g1")],
    );

    expect(ordinary.map((u) => u.label)).toEqual(["main"]);
    expect(groups[0].members.map((m) => m.unit)).toEqual([undefined, undefined]);
    expect(groups[0].members.map((m) => attemptFolderName(m.attempt.path))).toEqual([
      "try-1",
      "try-2",
    ]);
  });

  it("leaves a project with no attempts exactly as it was", () => {
    const units = [unit("/repo/main", "main"), unit("/repo/feature", "feature")];
    const { units: ordinary, groups } = groupAttempts(units, []);

    expect(ordinary).toEqual(units);
    expect(groups).toEqual([]);
  });

  // git reports a worktree under `$TMPDIR` as `/private/var/...` while the
  // recorded path came from the root Sway was given, so an unnormalized compare
  // would render every attempt twice: once in its group, once as a worktree.
  it("matches a recorded path against git's /private form", () => {
    expect(samePath("/var/folders/x/repo/a", "/private/var/folders/x/repo/a")).toBe(true);
    expect(samePath("/repo/a/", "/repo/a")).toBe(true);
    expect(samePath("/repo/a", "/repo/b")).toBe(false);

    const { units: ordinary, groups } = groupAttempts(
      [unit("/private/var/repo/.sway-attempts/try-1", "try-1")],
      [attempt("/var/repo/.sway-attempts/try-1", "g1")],
    );
    expect(ordinary).toEqual([]);
    expect(groups[0].members[0].unit?.label).toBe("try-1");
  });
});
