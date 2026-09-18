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

/** The mark a space wears wherever it has no icon: the sidebar tile, the menu
 *  header, the appearance preview, the picker's no-icon tile.
 *
 *  One character, the name's first alphanumeric one, because the sidebar tile
 *  is where this mark is actually worn and it holds exactly one: a second
 *  character is legible in the 48px preview and not in the tile the preview is
 *  previewing. `group-2` and `group-3` both read `G`, which is the cost, and
 *  the tile carries its name on hover for the rest.
 *
 *  The first *alphanumeric*, not the first character: a space called `-api`
 *  wears `A` rather than a dash. A name with no alphanumerics at all falls back
 *  to `?`. */
export function spaceInitials(name: string): string {
  const [first] = String(name ?? "").split(/[^a-z0-9]+/i).filter(Boolean);
  return first ? first[0].toUpperCase() : "?";
}
