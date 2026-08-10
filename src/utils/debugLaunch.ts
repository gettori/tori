// Turning a chosen target into a running debug session.
//
// The impure half of `debugTargets.ts`: it asks the backend for the three
// things a config needs that only the backend knows, builds the config with the
// pure rules, and hands it to `dapSessions`. Split so every rule about *what* a
// config says is testable without a workspace on disk, and only the *asking* is
// here.
//
// The root is asked for rather than derived. `root_for` exists in Rust and is
// deliberately the only implementation: `cwd` decides module resolution for the
// debuggee and where its source maps resolve from, so a second answer in
// TypeScript would not merely disagree, it would pair a monorepo package with
// the wrong config and its breakpoints would never bind.

import { invoke } from "@tauri-apps/api/core";

import { startDebugSession, type DapSession } from "./dapSessions";
import { anchorFor, attachFailureMessage, configFor, type DebugTarget } from "./debugTargets";
import { parsePackageScripts, packageRunner } from "./tasks";

/** The adapter every JavaScript and TypeScript target uses. One adapter ships;
 *  when a second does, this becomes a lookup in `dap_registry`. */
export const JS_ADAPTER = "js-debug";

type DirEntry = { name: string };

async function entriesOf(root: string): Promise<string[]> {
  const entries = await invoke<DirEntry[]>("fs_read_dir", { path: root }).catch(() => []);
  return (entries ?? []).map((e) => e.name);
}

/** Where a target for `anchor` will actually run. The dialog needs this before
 *  anything starts, because the scripts it offers are that root's, not the
 *  workspace root's. */
export async function resolveRoot(anchor: string, projectPath: string): Promise<string> {
  return invoke<string>("dap_root_for", {
    adapterId: JS_ADAPTER,
    filePath: anchor,
    projectPath,
  }).catch(() => projectPath);
}

/**
 * The scripts offered for a package-script target: the ones declared by the
 * `package.json` at the *resolved* root.
 *
 * In a monorepo that is the package's own scripts, which is the only list that
 * can actually be run from the `cwd` the config will carry.
 */
export async function scriptsAt(root: string): Promise<string[]> {
  const names = await entriesOf(root);
  if (!names.includes("package.json")) return [];
  const json = await invoke<string>("fs_read_file", { path: `${root}/package.json` }).catch(() => "");
  return parsePackageScripts(json, packageRunner(names)).map((t) => t.name);
}

/** Start `target`. Resolves to the root session, or null when it could not be
 *  started; `onError` is given something worth showing when that happens. */
export async function launchTarget(
  target: DebugTarget,
  opts: { projectPath: string; onError: (message: string) => void },
): Promise<DapSession | null> {
  const anchor = anchorFor(target, opts.projectPath);
  const root = await resolveRoot(anchor, opts.projectPath);
  const [entries, env] = await Promise.all([
    entriesOf(root),
    invoke<Record<string, string>>("dap_launch_env").catch(() => ({})),
  ]);

  const config = configFor(target, { root, entries, env });
  return startDebugSession({
    adapterId: JS_ADAPTER,
    filePath: anchor,
    projectPath: opts.projectPath,
    config,
    onLaunchFailed: (e) => {
      // An attach failure has one common cause and the adapter's own message
      // does not name it, so it gets the message that does. A launch failure is
      // already specific (a missing file, a script that does not exist), so it
      // is passed through rather than dressed up.
      opts.onError(
        target.kind === "attach"
          ? attachFailureMessage(target.port, e)
          : `Could not start the debugger: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  });
}
