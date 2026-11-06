export type OperationKind = "rebase" | "merge" | "cherry-pick" | "revert";

export type Operation = {
  kind: OperationKind;
  replaying?: string;
  step?: number;
  total?: number;
  conflicted: number;
};

type UnitLike = {
  label: string;
  folderPath: string;
  branch: string | null;
  kind: string;
  isCurrent: boolean;
  operation?: Operation;
};

const VERB: Record<OperationKind, string> = {
  rebase: "Rebasing",
  merge: "Merging",
  "cherry-pick": "Cherry-picking",
  revert: "Reverting",
};

// Several plain units share the repo's folder, and only the checkout is the
// one an operation in that folder belongs to.
export const ownsFolder = (u: Pick<UnitLike, "kind" | "isCurrent">) =>
  u.kind === "worktree" || (u.kind === "plain" && u.isCurrent);

export function displayBranch(u: UnitLike): string {
  const op = u.operation;
  if (op?.kind === "rebase" && op.replaying) return op.replaying;
  return u.branch ?? u.label;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type OperationChip = {
  text: string;
  files: string | null;
  conflicted: boolean;
  title: string;
};

export function operationChip(op: Operation): OperationChip {
  const progress = op.step != null && op.total != null ? ` ${op.step}/${op.total}` : "";
  const conflicted = op.conflicted > 0;
  const what = op.kind === "rebase" && op.replaying ? `rebase of ${op.replaying}` : op.kind;
  const at = op.step != null && op.total != null ? `, at commit ${op.step} of ${op.total}` : "";
  return {
    text: `${conflicted ? "Conflict" : VERB[op.kind]}${progress}`,
    files: conflicted ? plural(op.conflicted, "file") : null,
    conflicted,
    title: conflicted
      ? `The ${what} stopped on a conflict in ${plural(op.conflicted, "file")}${at}. Resolve, then continue it.`
      : `A ${what} is in progress${at}.`,
  };
}

type ProjectLike<U> = { branchUnits: U[] };
type ConfigLike<U> = { spaces: { projects: ProjectLike<U>[] }[]; global: { projects: ProjectLike<U>[] } };

export function applyOperation<U extends UnitLike, C extends ConfigLike<U>>(
  cfg: C,
  folder: string,
  op: Operation | null,
): { config: C; reload: boolean } {
  let reload = false;
  const units = (us: U[]) => {
    let changed = false;
    const next = us.map((u) => {
      if (u.folderPath !== folder || !ownsFolder(u)) return u;
      // A start or an end also moves the branch the unit reports.
      if (!u.operation !== !op) reload = true;
      changed = true;
      const { operation: _old, ...rest } = u;
      return (op ? { ...rest, operation: op } : rest) as U;
    });
    return changed ? next : us;
  };
  const projects = <P extends ProjectLike<U>>(ps: P[]) => {
    let changed = false;
    const next = ps.map((p) => {
      const branchUnits = units(p.branchUnits);
      if (branchUnits === p.branchUnits) return p;
      changed = true;
      return { ...p, branchUnits };
    });
    return changed ? next : ps;
  };
  const spaces = cfg.spaces.map((s) => {
    const ps = projects(s.projects);
    return ps === s.projects ? s : { ...s, projects: ps };
  });
  const global = projects(cfg.global.projects);
  const changed = spaces.some((s, i) => s !== cfg.spaces[i]) || global !== cfg.global.projects;
  if (!changed) return { config: cfg, reload };
  return {
    config: {
      ...cfg,
      spaces,
      global: global === cfg.global.projects ? cfg.global : { ...cfg.global, projects: global },
    },
    reload,
  };
}
