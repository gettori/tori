import type { OpenJob } from "./events";
import type { InstallRoute } from "./install";

/** Mirrors `crate::git_health::GitHealth`. */
export type GitHealth =
  | { kind: "ready"; path: string; version: string | null }
  | { kind: "bashMissing"; path: string; version: string | null }
  | { kind: "toolsMissing" }
  | { kind: "notFound" };

/** Mirrors `crate::git_health::GitReport`. */
export type GitReport = { health: GitHealth; install: InstallRoute };

/** The job that installs git, or `null` when there is nothing to run. */
export function gitInstallJob(route: InstallRoute, cwd: string): OpenJob | null {
  if (route.type !== "terminal") return null;
  return {
    id: "install:git",
    title: "Install git",
    cwd,
    program: route.program,
    args: route.args,
    interactive: true,
  };
}
