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
