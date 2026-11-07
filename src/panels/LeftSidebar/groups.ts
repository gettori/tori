export type BranchGroup = { name: string; colour?: string; branches: string[] };

const tidy = (groups: BranchGroup[]) => groups.filter((g) => g.branches.length > 0);

const without = (groups: readonly BranchGroup[], branches: readonly string[]) =>
  groups.map((g) => ({ ...g, branches: g.branches.filter((b) => !branches.includes(b)) }));

export function freeName(groups: readonly BranchGroup[], base = "New group"): string {
  const taken = new Set(groups.map((g) => g.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function createGroup(groups: readonly BranchGroup[], name: string, branches: readonly string[]): BranchGroup[] {
  return tidy([...without(groups, branches), { name, branches: [...branches] }]);
}

export function putInGroup(groups: readonly BranchGroup[], name: string, branch: string, index: number): BranchGroup[] {
  return tidy(
    without(groups, [branch]).map((g) => {
      if (g.name !== name) return g;
      const at = Math.max(0, Math.min(index, g.branches.length));
      return { ...g, branches: [...g.branches.slice(0, at), branch, ...g.branches.slice(at)] };
    }),
  );
}

export const takeOut = (groups: readonly BranchGroup[], branch: string) => tidy(without(groups, [branch]));

export function renameGroup(groups: readonly BranchGroup[], from: string, to: string): BranchGroup[] | null {
  const name = to.trim();
  if (!name || groups.some((g) => g.name === name && g.name !== from)) return null;
  return groups.map((g) => (g.name === from ? { ...g, name } : g));
}

export const ungroup = (groups: readonly BranchGroup[], name: string) => groups.filter((g) => g.name !== name);

export const groupOf = (groups: readonly BranchGroup[], branch: string) =>
  groups.find((g) => g.branches.includes(branch));
