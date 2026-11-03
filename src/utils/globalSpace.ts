export const GLOBAL_NAME = "Home";

// Spaces are keyed by their folder's name, and no folder name can contain a
// slash, so no space on disk can ever collide with this one.
export const GLOBAL_KEY = "/global";

export const GLOBAL_ICON = "House";
export const GLOBAL_COLOR = "Teal";

export const spaceLabel = (name: string) => (name === GLOBAL_KEY ? GLOBAL_NAME : name);

type SpaceLike = { name: string; projects: unknown[]; icon?: string; color?: string };
type ConfigLike<S extends SpaceLike> = {
  spaces: S[];
  global?: { projects: S["projects"]; icon?: string; color?: string };
};

export type GlobalGroup<S extends SpaceLike> = Pick<S, "projects"> & { name: string; icon: string; color: string };

/** Every space that holds projects: the named ones, then Global when it lists
 *  any. A caller that needs a space's folder has to narrow first. */
export function allSpaces<S extends SpaceLike>(cfg: ConfigLike<S> | null | undefined): (S | GlobalGroup<S>)[] {
  const spaces = cfg?.spaces ?? [];
  const projects = cfg?.global?.projects ?? [];
  if (projects.length === 0) return spaces;
  const global = {
    name: GLOBAL_KEY,
    projects,
    icon: cfg?.global?.icon ?? GLOBAL_ICON,
    color: cfg?.global?.color ?? GLOBAL_COLOR,
  } as GlobalGroup<S>;
  return [...spaces, global];
}
