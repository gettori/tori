import { rollupStatuses, statusFromDot, type Rollup } from "../../src/utils/sessionStatus";

export type Home = { project: string; folder: string; branch: string | null };

export type SessionRow = {
  id: string;
  agent?: string;
  title?: string | null;
  name?: string | null;
  cwd?: string;
  live?: boolean;
  dot?: string;
  last_active: number;
  home?: Home;
};

export type UnitGit = { added: number; deleted: number; ahead: number | null; behind: number | null };

export type Phase = "working" | "needs" | "idle" | "ended";

export const PHASE_LABEL: Record<Phase, string> = { working: "Working", needs: "Needs you", idle: "Idle", ended: "Ended" };

export type Unit = {
  label: string;
  folder: string;
  branch: string | null;
  kind: "worktree" | "plain" | "plain-dir" | "incomplete";
  isCurrent: boolean;
};

export type Project = { name: string; path: string; units: Unit[] };

export type Space = { name: string; path: string; icon: string | null; color: string | null; projects: Project[] };

export type TopicMember = { repoPath: string; displayName: string; worktreePath: string; order: number };

export type Topic = { id: string; name: string; branch: string; members: TopicMember[] };

export type Tree = { spaces: Space[]; topics: Topic[] };

export function inUnit(home: Home | undefined, unit: Unit): boolean {
  return home?.folder === unit.folder && home.branch === unit.branch;
}

const under = (path: string | undefined, folder: string) => !!path && (path === folder || path.startsWith(`${folder}/`));

// A Topic member's worktree is not a unit in the tree, so the Mac homes its
// sessions nowhere, or under the repo it sits inside; the deeper folder wins.
export function atUnit(row: SessionRow, unit: Unit): boolean {
  if (inUnit(row.home, unit)) return true;
  const home = row.home?.folder;
  return under(row.cwd, unit.folder) && (!home || home.length < unit.folder.length);
}

export function rollupOf(rows: SessionRow[]): Rollup {
  return rollupStatuses(rows.map((row) => ({ status: statusFromDot(row.dot ?? "none") })));
}

export function phaseOf(row: SessionRow): Phase {
  if (!row.live) return "ended";
  const rollup = rollupOf([row]);
  if (rollup.waitingForApproval + rollup.waitingForAnswer > 0) return "needs";
  return rollup.executing > 0 ? "working" : "idle";
}

export function newest(rows: SessionRow[]): SessionRow | undefined {
  return rows.reduce<SessionRow | undefined>((best, row) => (!best || row.last_active > best.last_active ? row : best), undefined);
}

export function sessionLabel(row: SessionRow): string {
  return row.name || row.title || row.cwd || row.id;
}

export function projectRows(project: Project, live: SessionRow[]): SessionRow[] {
  return live.filter((row) => project.units.some((unit) => inUnit(row.home, unit)));
}

export function matches(text: string | null | undefined, query: string): boolean {
  return !!text && text.toLowerCase().includes(query.toLowerCase());
}
