/** Why a space or project name would be refused, or null when it would not.
 *  An inline mirror of the server's `valid_name` (src-tauri/src/config.rs),
 *  for immediate feedback only: the server's check is the real guard. */
export function badName(n: string): string | null {
  const t = n.trim();
  if (!t) return "Name is empty";
  if (t.includes("/") || t.includes("\\")) return "Name cannot contain a slash";
  if (t.startsWith(".")) return "Name cannot start with a dot";
  return null;
}

/** A path with the home folder folded to `~`, for display only. */
export function shortHome(path: string, home: string): string {
  return home.length > 1 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The mark a space wears wherever it has no icon: the tab, the sidebar tile,
 *  the appearance preview, the picker's no-icon tile.
 *
 *  Split on runs of non-alphanumerics, then one segment gives its first two
 *  characters and two or more give the first character of each of the first
 *  two: `group-2` reads `G2`, `api` reads `AP`. Two characters rather than one
 *  because a base folder of `api`, `app` and `admin` is three tiles all marked
 *  `A` otherwise, which is the state the single initial actually shipped in.
 *
 *  A name with no alphanumerics at all falls back to the same `?` the sidebar
 *  tile already used for an empty one. */
export function spaceInitials(name: string): string {
  const parts = String(name ?? "").split(/[^a-z0-9]+/i).filter(Boolean);
  if (!parts.length) return "?";
  const mark = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return mark.toUpperCase();
}
