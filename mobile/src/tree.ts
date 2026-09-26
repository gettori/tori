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

export function rollupOf(rows: SessionRow[]): Rollup {
  return rollupStatuses(rows.map((row) => ({ status: statusFromDot(row.dot ?? "none") })));
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
