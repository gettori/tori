import { describe, expect, it } from "vite-plus/test";
import { applyOperation, displayBranch, operationChip, type Operation } from "./worktreeOperation";

const rebasing: Operation = { kind: "rebase", replaying: "feat-login", step: 3, total: 7, conflicted: 0 };

const unit = (over: Partial<Parameters<typeof displayBranch>[0]> = {}) => ({
  label: "(detached)",
  folderPath: "/c/feat",
  branch: "(detached)",
  kind: "worktree",
  isCurrent: false,
  ...over,
});

describe("the branch a unit shows", () => {
  it("is the branch a rebase replays, not (detached)", () => {
    expect(displayBranch(unit({ operation: rebasing }))).toBe("feat-login");
  });

  it("stays the unit's own branch otherwise", () => {
    expect(displayBranch(unit())).toBe("(detached)");
    expect(displayBranch(unit({ branch: "main", operation: { kind: "merge", conflicted: 1 } }))).toBe("main");
    expect(displayBranch(unit({ operation: { kind: "rebase", conflicted: 0 } }))).toBe("(detached)");
  });
});

describe("the operation chip", () => {
  it("names the operation and its progress", () => {
    expect(operationChip(rebasing)).toMatchObject({ text: "Rebasing 3/7", files: null, conflicted: false });
    expect(operationChip({ kind: "merge", conflicted: 0 }).text).toBe("Merging");
    expect(operationChip({ kind: "cherry-pick", conflicted: 0 }).text).toBe("Cherry-picking");
    expect(operationChip({ kind: "revert", conflicted: 0 }).text).toBe("Reverting");
  });

  it("says conflict and counts the files when it stopped on one", () => {
    const chip = operationChip({ ...rebasing, conflicted: 1 });
    expect(chip).toMatchObject({ text: "Conflict 3/7", files: "1 file", conflicted: true });
    expect(chip.title).toBe(
      "The rebase of feat-login stopped on a conflict in 1 file, at commit 3 of 7. Resolve, then continue it.",
    );
    expect(operationChip({ kind: "merge", conflicted: 2 }).files).toBe("2 files");
  });
});

describe("applying an operation event", () => {
  const cfg = () => ({
    spaces: [
      {
        name: "Saga",
        projects: [
          {
            name: "frontend",
            branchUnits: [unit(), unit({ folderPath: "/c/main", branch: "main", label: "main" })],
          },
        ],
      },
      { name: "Other", projects: [{ name: "x", branchUnits: [unit({ folderPath: "/x" })] }] },
    ],
    global: {
      projects: [
        {
          name: "repo",
          branchUnits: [
            unit({ folderPath: "/repo", kind: "plain", isCurrent: true, branch: "main" }),
            unit({ folderPath: "/repo", kind: "plain", isCurrent: false, branch: "feat" }),
          ],
        },
      ],
    },
  });

  it("patches only the unit that owns the folder and asks for a reload when one starts", () => {
    const before = cfg();
    const { config, reload } = applyOperation(before, "/c/feat", rebasing);
    expect(reload).toBe(true);
    expect(config.spaces[0].projects[0].branchUnits[0].operation).toEqual(rebasing);
    expect(config.spaces[0].projects[0].branchUnits[1]).toBe(before.spaces[0].projects[0].branchUnits[1]);
    expect(config.spaces[1]).toBe(before.spaces[1]);
    expect(config.global).toBe(before.global);
  });

  it("moves a step without a reload, and reloads when it ends", () => {
    const started = applyOperation(cfg(), "/c/feat", rebasing).config;
    const step = applyOperation(started, "/c/feat", { ...rebasing, step: 4 });
    expect(step.reload).toBe(false);
    expect(step.config.spaces[0].projects[0].branchUnits[0].operation?.step).toBe(4);
    const ended = applyOperation(step.config, "/c/feat", null);
    expect(ended.reload).toBe(true);
    expect("operation" in ended.config.spaces[0].projects[0].branchUnits[0]).toBe(false);
  });

  it("gives a plain repo's operation to its checkout only", () => {
    const { config } = applyOperation(cfg(), "/repo", rebasing);
    const [current, other] = config.global.projects[0].branchUnits;
    expect(current.operation).toEqual(rebasing);
    expect(other.operation).toBeUndefined();
  });

  it("returns the same config for a folder it does not list", () => {
    const before = cfg();
    expect(applyOperation(before, "/nowhere", rebasing)).toEqual({ config: before, reload: false });
  });
});
