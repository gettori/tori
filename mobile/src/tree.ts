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

export type Space = { name: string; path: string; projects: Project[] };

export function inUnit(home: Home | undefined, unit: Unit): boolean {
  return home?.folder === unit.folder && home.branch === unit.branch;
}

export function rollupOf(rows: SessionRow[]): Rollup {
  return rollupStatuses(rows.map((row) => ({ status: statusFromDot(row.dot ?? "none") })));
}

export function sessionLabel(row: SessionRow): string {
  return row.name || row.title || row.cwd || row.id;
}
