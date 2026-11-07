import { invoke } from "@tauri-apps/api/core";
import { moveProjects, type MoveRequest } from "./moveProjects";
import { badName } from "./names";

export type ScanLayout = { kind: "plain" } | { kind: "clone" } | { kind: "bare" };

export type RootScan = {
  base: string;
  folders: { name: string; entries: string[] }[];
  hidden: string[];
  spaces: { name: string; path: string; projects: number }[];
  misplaced: { path: string; relative: string; name: string; layout: ScanLayout; suggestion?: string | null }[];
  emptyTop: string[];
  tooBig: string[];
  tooDeep: string[];
  unreadable: string[];
  refused?: string;
};

export type Row = { path: string; relative: string; kind: ScanLayout["kind"]; name: string; space: string | null };

export type Plan = { rows: Row[]; extraSpaces: string[]; keepEmpty: string[] };

export const scanFits = (scan: RootScan) => !scan.refused && scan.misplaced.length === 0;

export function initialPlan(scan: RootScan): Plan {
  return {
    rows: scan.misplaced.map((m) => ({
      path: m.path,
      relative: m.relative,
      kind: m.layout.kind,
      name: m.name,
      space: m.suggestion ?? null,
    })),
    extraSpaces: [],
    keepEmpty: [],
  };
}

const lower = (s: string) => s.toLowerCase();

// Top-level names a new space cannot take: a loose project still sits there.
const looseNames = (scan: RootScan) =>
  scan.misplaced.filter((m) => !m.relative.includes("/")).map((m) => lower(m.relative));

export function spaceChoices(scan: RootScan, plan: Plan): string[] {
  const names = new Map<string, string>();
  for (const n of [
    ...scan.folders.map((f) => f.name),
    ...plan.extraSpaces,
    ...plan.rows.flatMap((r) => (r.space ? [r.space] : [])),
  ]) {
    if (!names.has(lower(n))) names.set(lower(n), n);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export function spaceProblem(scan: RootScan, name: string): string | null {
  const bad = badName(name);
  if (bad) return bad;
  if (looseNames(scan).includes(lower(name.trim()))) return "A project already has that name here";
  return null;
}

export function rowProblems(scan: RootScan, plan: Plan): Map<string, string> {
  const problems = new Map<string, string>();
  const landing = new Map<string, string[]>();
  for (const r of plan.rows) {
    if (!r.space) continue;
    const bad = badName(r.name) ?? spaceProblem(scan, r.space);
    if (bad) problems.set(r.path, bad);
    const key = `${lower(r.space)}/${lower(r.name.trim())}`;
    landing.set(key, [...(landing.get(key) ?? []), r.path]);
    const folder = scan.folders.find((f) => lower(f.name) === lower(r.space!));
    if (folder?.entries.some((e) => lower(e) === lower(r.name.trim()))) {
      problems.set(r.path, `${folder.name} already has a folder named ${r.name.trim()}`);
    }
  }
  for (const paths of landing.values()) {
    if (paths.length < 2) continue;
    for (const p of paths) if (!problems.has(p)) problems.set(p, "Two projects would get the same name here");
  }
  return problems;
}

// A folder the scan did not finish reading may hold projects it never saw, so
// it is never hidden.
export function hiddenAfter(scan: RootScan, plan: Plan): string[] {
  const unread = (name: string) =>
    scan.tooBig.includes(name) || scan.unreadable.some((u) => u === name || u.startsWith(`${name}/`));
  return scan.folders
    .map((f) => f.name)
    .filter((name) => !unread(name))
    .filter((name) => {
      const kept = scan.spaces.find((s) => s.name === name)?.projects ?? 0;
      const moved = plan.rows.filter((r) => r.space && lower(r.space) === lower(name)).length;
      return kept + moved === 0 && !plan.keepEmpty.includes(name);
    });
}

export type Applied = { spaces: number; moved: number; attached: number; warnings: string[] };

export async function applyPlan(scan: RootScan, plan: Plan, opts: { setRoot: boolean }): Promise<Applied> {
  const base = scan.base;
  const existing = new Set(scan.folders.map((f) => lower(f.name)));
  const moving = plan.rows.filter((r): r is Row & { space: string } => !!r.space);
  const targets = [...new Set(moving.map((r) => r.space.trim()))];
  const hidden = new Set(scan.hidden.map(lower));
  // add_space on a hidden folder unhides it, so a project never moves into a
  // space the sidebar does not show.
  const newSpaces = targets.filter((s) => !existing.has(lower(s)) || hidden.has(lower(s)));
  const warnings: string[] = [];

  if (opts.setRoot) await invoke("set_root", { path: base });
  for (const name of newSpaces) await invoke("add_space", { root: base, name, icon: null, color: null });
  if (moving.length) {
    const moves: MoveRequest[] = moving.map((r) => ({ space: r.space.trim(), name: r.name.trim(), path: r.path }));
    const done = await moveProjects(base, moves);
    if (done.warning) warnings.push(done.warning);
  }
  const staying = plan.rows.filter((r) => !r.space);
  for (const r of staying) {
    const done = await invoke<{ warning?: string }>("attach_folder", { path: r.path, name: r.name.trim() || r.name });
    if (done.warning) warnings.push(done.warning);
  }
  const hide = hiddenAfter(scan, plan);
  if (hide.length) await invoke("hide_spaces", { names: hide });
  return { spaces: newSpaces.length, moved: moving.length, attached: staying.length, warnings };
}
