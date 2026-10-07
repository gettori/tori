import type { ContentBlock } from "./chatTypes";

export type NavUnit = { label: string; folderPath: string; branch: string | null; kind: string; isCurrent: boolean };
export type NavProject = { name: string; path: string; branchUnits: NavUnit[] };
export type NavSpace = { name: string; path: string; projects: NavProject[] };

export type Keyed<T> = { key: string; item: T };

/** Each node under the basename of its path, which has no spaces to break a
 *  mention on, with `-2`, `-3` on a repeat in the order given. */
export function keyed<T>(items: readonly T[], pathOf: (item: T) => string): Keyed<T>[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = pathOf(item).replace(/\/+$/, "").split("/").pop() || "root";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: n === 1 ? base : `${base}-${n}`, item };
  });
}

/** The units a drill can list files from. Only the checked out branch of a
 *  plain repo has its files on disk, and an incomplete stub has none. */
export function unitsOf(project: NavProject): Keyed<NavUnit>[] {
  const live = project.branchUnits.filter((u) => u.kind !== "incomplete" && (u.kind !== "plain" || u.isCurrent));
  return keyed(live, (u) => u.folderPath);
}

export type NavLevel =
  | { level: "spaces"; spaces: Keyed<NavSpace>[]; query: string }
  | { level: "projects"; space: NavSpace; projects: Keyed<NavProject>[]; query: string }
  | { level: "project"; space: NavSpace; project: NavProject; units: Keyed<NavUnit>[]; query: string }
  | { level: "files"; space: NavSpace; project: NavProject; unit: NavUnit; query: string };

/** Where `@spaces/...` or `@projects/...` has walked to. Every segment but the
 *  last names a node by its key; the last filters that node's children, and
 *  under a unit the whole rest is a file query, slashes included. Null when a
 *  segment names nothing, or for `projects` when the chat is in no space. */
export function navLevel(
  scope: "spaces" | "projects",
  rest: string,
  spaces: readonly NavSpace[],
  here: NavSpace | null,
): NavLevel | null {
  const segs = rest.split("/");
  let space = here;
  if (scope === "spaces") {
    const all = keyed(spaces, (g) => g.path);
    if (segs.length === 1) return { level: "spaces", spaces: all, query: segs[0] };
    space = all.find((k) => k.key === segs.shift())?.item ?? null;
  }
  if (!space) return null;
  const projects = keyed(space.projects, (p) => p.path);
  if (segs.length === 1) return { level: "projects", space, projects, query: segs[0] };
  const project = projects.find((k) => k.key === segs[0])?.item;
  if (!project) return null;
  const units = unitsOf(project);
  if (segs.length === 2) return { level: "project", space, project, units, query: segs[1] };
  const unit = units.find((k) => k.key === segs[1])?.item;
  if (!unit) return null;
  return { level: "files", space, project, unit, query: segs.slice(2).join("/") };
}

export function projectRef(space: NavSpace, project: NavProject, label: string): ContentBlock {
  return {
    type: "ref",
    label,
    target: { kind: "project", name: project.name, folder: project.path, space: space.name },
  };
}

export function spaceRef(space: NavSpace, label: string): ContentBlock {
  return {
    type: "ref",
    label,
    target: {
      kind: "space",
      name: space.name,
      projects: space.projects.map((p) => ({ name: p.name, folder: p.path })),
    },
  };
}
