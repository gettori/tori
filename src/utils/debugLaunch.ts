// Turning a chosen target into a running debug session.
//
// The impure half of `debugTargets.ts`: it asks the backend for the things a
// config needs that only the backend knows, builds the config with the
// pure rules, and hands it to `dapSessions`. Split so every rule about *what* a
// config says is testable without a workspace on disk, and only the *asking* is
// here.
//
// The root is asked for rather than derived. `root_for` exists in Rust and is
// deliberately the only implementation: `cwd` decides module resolution for the
// debuggee and where its source maps resolve from, so a second answer in
// TypeScript would not merely disagree, it would pair a monorepo package with
// the wrong config and its breakpoints would never bind.

import { Channel, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

import { debugRoots, refuseUntrustedRun, startDebugSession, type DapSession } from "./dapSessions";
import { debugBuild, endDebugBuild, noteConsoleLine, startDebugBuild } from "./debugStore";
import {
  anchorFor,
  attachFailureMessage,
  configFor,
  LLDB_ADAPTER,
  PYTHON_ADAPTER,
  type CargoBuilt,
  type DapAdapterInfo,
  type DebugTarget,
  type LldbPick,
} from "./debugTargets";
import { emitWith, OPEN_JOB, TOAST, type OpenJob, type ToastEvent } from "./events";
import { extensionOf } from "./lspServers";
import { UNTRUSTED } from "./projectTrust";
import { commandIn, NOT_INSTALLED } from "./serverInstall";
import { parsePackageScripts, packageRunner } from "./tasks";

let registry: Promise<DapAdapterInfo[]> | null = null;

/** Every registered debug adapter. Asked once, since the backend loads them once
 *  at startup; a failed ask is not kept, so the next call retries it. */
export function dapAdapters(): Promise<DapAdapterInfo[]> {
  registry ??= invoke<DapAdapterInfo[]>("dap_registry").catch(() => {
    registry = null;
    return [];
  });
  return registry;
}

/** The adapter that runs `path`, by its extension, or null. */
export function adapterForPath(adapters: readonly DapAdapterInfo[], path: string | null): DapAdapterInfo | null {
  const ext = path ? extensionOf(path) : null;
  return (ext && adapters.find((a) => ext in a.languages)) || null;
}

type DirEntry = { name: string };

async function entriesOf(root: string): Promise<string[]> {
  const entries = await invoke<DirEntry[]>("fs_read_dir", { path: root }).catch(() => []);
  return (entries ?? []).map((e) => e.name);
}

/** Where `adapterId` will run a target for `anchor`. The dialog needs this
 *  before anything starts, because the scripts it offers are that root's, not
 *  the workspace root's. */
export async function resolveRoot(adapterId: string, anchor: string, projectPath: string): Promise<string> {
  return invoke<string>("dap_root_for", {
    adapterId,
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

/** Where an lldb target picked now would run, and the Cargo binaries there.
 *  Null when the project is not trusted, having offered to trust it: listing
 *  the binaries runs cargo. */
export async function lldbPickAt(anchor: string, projectPath: string): Promise<LldbPick | null> {
  const root = await resolveRoot(LLDB_ADAPTER, anchor, projectPath);
  if (!(await entriesOf(root)).includes("Cargo.toml")) return { root, bins: [], error: null };
  try {
    return { root, bins: await invoke<string[]>("dap_cargo_bins", { root, projectPath }), error: null };
  } catch (e) {
    if (e !== UNTRUSTED) return { root, bins: [], error: String(e) };
    refuseUntrustedRun(projectPath);
    return null;
  }
}

/** Mirrors `dap::cargo::CANCELLED`. */
const CANCELLED = "cancelled";

let builds = 0;

// A cancel says nothing: the user asked for it.
async function buildCargo(
  bin: string,
  root: string,
  opts: { projectPath: string; onError: (message: string) => void },
): Promise<CargoBuilt | null> {
  const buildId = `build${builds++}`;
  const onLine = new Channel<string>();
  onLine.onmessage = (line) => noteConsoleLine("cargo", "console", line);
  startDebugBuild({ label: `Building ${bin}`, cancel: () => void invoke("dap_cargo_cancel", { buildId }) });
  try {
    return await invoke<CargoBuilt>("dap_cargo_build", { root, projectPath: opts.projectPath, bin, buildId, onLine });
  } catch (e) {
    if (e === UNTRUSTED) refuseUntrustedRun(opts.projectPath);
    else if (e !== CANCELLED) opts.onError(`Could not build ${bin}: ${String(e)}`);
    return null;
  } finally {
    endDebugBuild();
  }
}

// The run is not retried after an install, so the next F5 starts it, as after
// a trust prompt.
function offerInstall(adapter: DapAdapterInfo): void {
  const toast = (event: ToastEvent) => emitWith<ToastEvent>(TOAST, event);
  const install = adapter.install;
  if (install?.kind === "pip") {
    toast({
      kind: "info",
      message: `${adapter.label} is not installed. Tori can install version ${install.version}.`,
      action: {
        label: "Install",
        run: () => {
          toast({ kind: "info", message: `Installing ${adapter.label}.` });
          invoke("dap_install", { adapterId: adapter.id }).then(
            () => toast({ kind: "info", message: `${adapter.label} is installed.` }),
            (e) => toast({ message: `Could not install ${adapter.label}: ${String(e)}` }),
          );
        },
      },
    });
    return;
  }
  const command = commandIn(install?.text ?? null);
  const runInTerminal = async (line: string) =>
    emitWith<OpenJob>(OPEN_JOB, {
      id: `dap-install:${adapter.id}`,
      title: `Install ${adapter.label}`,
      cwd: await homeDir().catch(() => "/"),
      program: "/bin/sh",
      args: ["-c", line],
      interactive: true,
    });
  toast({
    kind: "info",
    message: `${adapter.label} is not installed. ${install?.text ?? ""}`.trim(),
    action: command ? { label: "Install", run: () => void runInTerminal(command) } : undefined,
  });
}

/** Start `target`. Resolves to the root session, or null when it could not be
 *  started; `onError` is given something worth showing when that happens. */
export async function launchTarget(
  target: DebugTarget,
  opts: { projectPath: string; onError: (message: string) => void },
): Promise<DapSession | null> {
  const adapter = (await dapAdapters()).find((a) => a.id === target.adapterId);
  if (!adapter) {
    opts.onError(`No debugger is registered as ${target.adapterId}.`);
    return null;
  }
  const anchor = anchorFor(target, opts.projectPath);
  const root = await resolveRoot(adapter.id, anchor, opts.projectPath);

  // A start that joins the live run launches nothing, so it builds nothing, and
  // a second build would race the first over one target directory.
  const joins = debugRoots().some((s) => s.adapterId === adapter.id && s.projectPath === opts.projectPath);
  let built: CargoBuilt | null = null;
  if (target.kind === "cargo" && !joins) {
    built = debugBuild() ? null : await buildCargo(target.bin, root, opts);
    if (!built) return null;
  }

  const [entries, env, python] = await Promise.all([
    entriesOf(root),
    invoke<Record<string, string>>("dap_launch_env").catch(() => ({})),
    target.adapterId === PYTHON_ADAPTER
      ? invoke<string | null>("dap_python", { root, projectPath: opts.projectPath }).catch(() => null)
      : null,
  ]);

  const config = configFor(target, { root, entries, env, python: python ?? undefined, built: built ?? undefined });
  return startDebugSession({
    adapterId: adapter.id,
    childSessions: adapter.childSessions,
    filePath: anchor,
    projectPath: opts.projectPath,
    config,
    onLaunchFailed: (e) => {
      if (e === NOT_INSTALLED) return offerInstall(adapter);
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
