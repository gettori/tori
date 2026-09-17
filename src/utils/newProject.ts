// Creating a project under a space: an empty folder, a clone, or a bare repo
// with a worktree. Shared by the sidebar's New dialog and first run's project
// step, so both land the same layout on disk.
import { invoke } from "@tauri-apps/api/core";
import type { OpenJob } from "./events";
import { badName } from "./names";

export type NewProjectMode = "folder" | "clone" | "bare";

// Bare + worktree bootstrap, run as one `&&` chain in a terminal.
// $1 = repo URL, $2 = project folder (passed as args, never interpolated). The
// trailing `|| rm -rf` cleans up a half-built project on any failure; a killed
// run leaves a `.bare`-only stub, which discovery flags as `incomplete`.
// Not `set -e`: a shell ignores it in a subshell tested by `||`, so a failed
// clone ran on to "Done" and exited 0.
export const BOOTSTRAP_SCRIPT = `url="$1"; proj="$2"
git clone --bare -- "$url" "$proj/.bare" &&
  printf 'gitdir: ./.bare\\n' > "$proj/.git" &&
  git -C "$proj/.bare" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' &&
  git -C "$proj" fetch origin &&
  def="$(git -C "$proj/.bare" symbolic-ref --short HEAD)" &&
  git -C "$proj" worktree add "$def" "$def" &&
  { echo; echo "Done: '$proj' ready on branch '$def'."; } ||
  { echo; echo "Bootstrap failed; cleaning up $proj"; rm -rf "$proj"; exit 1; }`;

/** The folder name a clone of `url` would get. */
export const nameFromUrl = (url: string) =>
  url.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") ?? "";

/** Why a job cannot create `name` in the space, or null once the target is
 *  free. `add_folder` checks for itself; a clone only fails once it has run. */
export async function claimProjectFolder(spacePath: string, name: string): Promise<string | null> {
  const bad = badName(name);
  if (bad) return bad;
  const target = `${spacePath}/${name.trim()}`;
  if (await invoke<boolean>("file_exists", { path: target })) {
    return `"${name.trim()}" already exists`;
  }
  // Tori is creating this folder: adopt the target path so a clone/bootstrap
  // onto a path that once held sessions is not flagged historical.
  invoke("adopt_path", { path: target }).catch(() => {});
  return null;
}

/** The job that clones `url` into the space as `name`, which re-discovers
 *  projects when it exits. Native git progress and ambient auth, no in-app
 *  credentials. */
export function projectJob(mode: "clone" | "bare", spacePath: string, name: string, url: string): OpenJob {
  const n = name.trim();
  const kind = mode === "clone" ? "clone" : "bootstrap";
  const target = `${spacePath}/${n}`;
  return {
    // A fresh id per press, unlike an install or a login: two clones into two
    // folders are two clones, and neither should reveal the other.
    id: `${kind}:${target}:${Date.now()}`,
    title: `${kind} ${n}`,
    cwd: spacePath,
    program: mode === "clone" ? "git" : "sh",
    args: mode === "clone" ? ["clone", "--", url.trim(), n] : ["-c", BOOTSTRAP_SCRIPT, "tori", url.trim(), n],
    rediscoverOnExit: true,
  };
}
