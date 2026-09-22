// What "debug this" actually means, as a DAP launch or attach configuration.
//
// Every target belongs to one adapter, and each adapter offers its own kinds.
// js-debug's three are the three ways a Node program is already started: the
// file in front of you, a script the project declares, and a process somebody
// else started with `--inspect`. debugpy's are the three ways Python code is
// run: a file, a module (`python -m`), and a test file under pytest. Delve's
// are what `go run` and `go test` build: the package of the file in front of
// you. lldb-dap's are a Cargo binary, built first, and any program you name,
// which is how C and C++ are debugged. Everything here is pure: the caller supplies the resolved root, that root's directory
// listing and the launch environment, so every rule is testable without a
// workspace on disk.
//
// The `cwd` is the load-bearing field. It is the backend's `root_for` answer,
// not the workspace root, and in a monorepo those differ: `cwd` decides module
// resolution for the debuggee *and* where its source maps resolve from, so a
// package debugged at the workspace root does not merely behave worse, its
// breakpoints never bind.

import { packageRunner } from "./tasks";
import type { DebugConfig } from "./dapSessions";

/** The adapter every JavaScript and TypeScript target uses. */
export const JS_ADAPTER = "js-debug";

/** The adapter every Python target uses. */
export const PYTHON_ADAPTER = "debugpy";

/** The adapter every Go target uses. */
export const GO_ADAPTER = "delve";

/** The adapter every Rust, C and C++ target uses. */
export const LLDB_ADAPTER = "lldb";

export type DebugTarget =
  | { adapterId: typeof JS_ADAPTER; kind: "file"; path: string }
  | { adapterId: typeof JS_ADAPTER; kind: "script"; script: string }
  | { adapterId: typeof JS_ADAPTER; kind: "attach"; port: number }
  | { adapterId: typeof PYTHON_ADAPTER; kind: "file"; path: string }
  | { adapterId: typeof PYTHON_ADAPTER; kind: "module"; module: string }
  | { adapterId: typeof PYTHON_ADAPTER; kind: "pytest"; path: string }
  | { adapterId: typeof GO_ADAPTER; kind: "package"; path: string }
  | { adapterId: typeof GO_ADAPTER; kind: "test"; path: string }
  | { adapterId: typeof LLDB_ADAPTER; kind: "cargo"; dir: string; bin: string }
  | { adapterId: typeof LLDB_ADAPTER; kind: "program"; program: string };

export type TargetKind = DebugTarget["kind"];

/** A registered debug adapter, as much of a `dap_registry` row as the frontend
 *  reads. */
export type DapAdapterInfo = {
  id: string;
  label: string;
  /** Extension (dotless, lowercase) to the DAP `type`. */
  languages: Record<string, string>;
  childSessions: boolean;
  /** Tori's own install (`pip`), or the command a `hint` names. */
  install: { kind: "hint"; text: string } | { kind: "pip"; version: string } | null;
};

/** The kinds each adapter offers, in picker order. An adapter the backend
 *  registers and this table does not name has none yet. */
const ADAPTER_KINDS: Readonly<Record<string, readonly TargetKind[]>> = {
  [JS_ADAPTER]: ["file", "script", "attach"],
  [PYTHON_ADAPTER]: ["file", "module", "pytest"],
  [GO_ADAPTER]: ["package", "test"],
  [LLDB_ADAPTER]: ["cargo", "program"],
};

export function kindsFor(adapterId: string): readonly TargetKind[] {
  return ADAPTER_KINDS[adapterId] ?? [];
}

/** The kind the picker opens on: the first one there is something for. */
export function defaultKind(adapterId: string, has: { file: boolean; bins: boolean }): TargetKind | null {
  const kinds = kindsFor(adapterId);
  return kinds.find((k) => (has.file || k !== "file") && (has.bins || k !== "cargo")) ?? kinds[0] ?? null;
}

/** Everything a config needs that this module cannot work out for itself. */
export type TargetContext = {
  /** The backend's `root_for` answer for this target. Becomes `cwd`. */
  root: string;
  /** Names in `root`, for the lockfile rule. */
  entries: readonly string[];
  /** Environment for the debuggee. Carries the augmented PATH, because a
   *  GUI-launched Tori inherits a minimal one and `pnpm` is not on it
   *  (gotchas#gui-launched-processes-inherit-a-minimal-path). */
  env: Record<string, string>;
  /** The project's interpreter, for a Python target. */
  python?: string;
  /** What `cargo build` made, for a Cargo target. */
  built?: CargoBuilt;
};

/** What the picker offers lldb-dap: where it runs, the Cargo binaries there,
 *  and why there are none when cargo said. */
export type LldbPick = { root: string; bins: string[]; error: string | null };

/** `dap::cargo::Built`. */
export type CargoBuilt = {
  executable: string;
  /** Where the toolchain's lldb formatters live, or null when `rustc` would not
   *  say. */
  sysroot: string | null;
};

/** The DAP `type` every target uses. js-debug drives every JS dialect through
 *  this one type; the registry maps extensions to it. */
export const NODE_DEBUG_TYPE = "pwa-node";

/** The default inspector port `node --inspect` binds. */
export const DEFAULT_ATTACH_PORT = 9229;

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * Fields every *launch* carries, and no attach does.
 *
 * `console: "internalConsole"` keeps the debuggee's stdio on the DAP wire as
 * `output` events. Phase 1 measured the alternative: `integratedTerminal` and
 * `externalTerminal` both make js-debug issue `runInTerminal`, and a client that
 * cannot serve it loses the session at zero stops, zero output and zero errors,
 * completely silently. It is also declared on `INodeLaunchConfiguration` alone,
 * so sending it on an attach is a field the adapter has no slot for.
 *
 * `stopOnEntry: true` is not a user-facing pause; `dapSessions` continues
 * straight through it. It exists because Phase 1 proved the TypeScript
 * breakpoint failure is a *race*, not a configuration problem: a short-lived
 * target runs to completion before js-debug has resolved its source map, and
 * four variants of `outFiles` / `resolveSourceMapLocations` changed nothing.
 * Pausing at entry is what creates the window in which the map resolves.
 */
function launchBase(ctx: TargetContext): DebugConfig {
  return {
    type: NODE_DEBUG_TYPE,
    request: "launch",
    cwd: ctx.root,
    console: "internalConsole",
    stopOnEntry: true,
    env: ctx.env,
  };
}

/** Debug the file in front of you, run directly by node. */
export function fileConfig(ctx: TargetContext, path: string): DebugConfig {
  return { ...launchBase(ctx), name: `Debug ${basename(path)}`, program: path };
}

/**
 * Debug one of the project's own `package.json` scripts.
 *
 * The runner comes from the lockfile, reusing `tasks.ts`'s rule rather than a
 * second copy of it: `npm run dev` in a pnpm repo is not a preference somebody
 * got wrong, it is a command that installs the wrong tree.
 */
export function scriptConfig(ctx: TargetContext, script: string): DebugConfig {
  const runner = packageRunner(ctx.entries);
  return {
    ...launchBase(ctx),
    name: `Debug ${runner} run ${script}`,
    runtimeExecutable: runner,
    runtimeArgs: ["run", script],
  };
}

/**
 * Attach to a process somebody else started.
 *
 * Deliberately none of the launch fields. Tori did not start this process, so
 * it has no environment to hand it and no entry to pause at, and `console` does
 * not exist on `INodeAttachConfiguration` at all.
 */
export function attachConfig(ctx: TargetContext, port: number): DebugConfig {
  return {
    type: NODE_DEBUG_TYPE,
    request: "attach",
    name: `Attach to port ${port}`,
    port,
    cwd: ctx.root,
  };
}

/** The DAP `type` every Python target uses. */
export const PYTHON_DEBUG_TYPE = "debugpy";

/** A dotted Python module name, what `python -m` takes. */
export function isModuleName(value: string): boolean {
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(value);
}

/**
 * Fields every Python launch carries.
 *
 * `python` is the project's interpreter, not the one debugpy runs from: Tori's
 * own venv holds the adapter and none of the project's packages. Without one
 * debugpy falls back to its own. `console: "internalConsole"` for js-debug's
 * reason: anything else makes the adapter ask for `runInTerminal`, which Tori
 * does not serve.
 */
function pythonLaunch(ctx: TargetContext, name: string): DebugConfig {
  return {
    type: PYTHON_DEBUG_TYPE,
    request: "launch",
    name,
    cwd: ctx.root,
    console: "internalConsole",
    justMyCode: true,
    env: ctx.env,
    ...(ctx.python ? { python: ctx.python } : {}),
  };
}

function pythonConfigFor(target: DebugTarget & { adapterId: typeof PYTHON_ADAPTER }, ctx: TargetContext): DebugConfig {
  switch (target.kind) {
    case "file":
      return { ...pythonLaunch(ctx, `Debug ${basename(target.path)}`), program: target.path };
    case "module":
      return { ...pythonLaunch(ctx, `Debug -m ${target.module}`), module: target.module };
    case "pytest":
      return { ...pythonLaunch(ctx, `Debug pytest ${basename(target.path)}`), module: "pytest", args: [target.path] };
  }
}

/** The DAP `type` every Go target uses. */
export const GO_DEBUG_TYPE = "go";

/**
 * Fields every Go launch carries.
 *
 * `outputMode: "remote"` is Delve's `internalConsole`: without it the program
 * writes to Delve's own stdout, which Tori only logs, and the debug console
 * stays empty.
 */
function goLaunch(ctx: TargetContext, name: string): DebugConfig {
  return {
    type: GO_DEBUG_TYPE,
    request: "launch",
    name,
    cwd: ctx.root,
    outputMode: "remote",
    env: ctx.env,
  };
}

function goConfigFor(target: DebugTarget & { adapterId: typeof GO_ADAPTER }, ctx: TargetContext): DebugConfig {
  const pkg = dirname(target.path);
  switch (target.kind) {
    case "package":
      return { ...goLaunch(ctx, `Debug ${basename(pkg)}`), mode: "debug", program: pkg };
    case "test":
      // In the package's own directory, where `go test` runs a test, so its
      // `testdata/` resolves.
      return { ...goLaunch(ctx, `Debug tests in ${basename(pkg)}`), mode: "test", program: pkg, cwd: pkg };
  }
}

/** The DAP `type` every lldb-dap target uses. */
export const LLDB_DEBUG_TYPE = "lldb-dap";

// Without Rust's own formatters a `String` shows as the raw `Vec` inside it.
// `-s 1` keeps the sixty lines `lldb_commands` runs out of the console.
function rustFormatters(sysroot: string): string[] {
  const etc = `${sysroot}/lib/rustlib/etc`;
  return [`command script import "${etc}/lldb_lookup.py"`, `command source -s 1 "${etc}/lldb_commands"`];
}

// No `env`, unlike the other adapters: the program inherits lldb-dap's own
// environment, login PATH included.
function lldbConfigFor(target: DebugTarget & { adapterId: typeof LLDB_ADAPTER }, ctx: TargetContext): DebugConfig {
  const launch = { type: LLDB_DEBUG_TYPE, request: "launch", cwd: ctx.root };
  switch (target.kind) {
    case "cargo":
      return {
        ...launch,
        name: `Debug ${target.bin}`,
        program: ctx.built?.executable,
        initCommands: ctx.built?.sysroot ? rustFormatters(ctx.built.sysroot) : [],
      };
    case "program":
      return { ...launch, name: `Debug ${basename(target.program)}`, program: target.program };
  }
}

/** The config for one target, built by the rules of the adapter it runs under. */
export function configFor(target: DebugTarget, ctx: TargetContext): DebugConfig {
  switch (target.adapterId) {
    case JS_ADAPTER:
      return nodeConfigFor(target, ctx);
    case PYTHON_ADAPTER:
      return pythonConfigFor(target, ctx);
    case GO_ADAPTER:
      return goConfigFor(target, ctx);
    case LLDB_ADAPTER:
      return lldbConfigFor(target, ctx);
  }
}

function nodeConfigFor(target: DebugTarget & { adapterId: typeof JS_ADAPTER }, ctx: TargetContext): DebugConfig {
  switch (target.kind) {
    case "file":
      return fileConfig(ctx, target.path);
    case "script":
      return scriptConfig(ctx, target.script);
    case "attach":
      return attachConfig(ctx, target.port);
  }
}

/** The file a target's root should be resolved against.
 *
 *  A Cargo target keeps the package it was picked in. A script, an attach, a
 *  module and a program have no file of their own, so they resolve against the
 *  root the picker was opened at, which the caller passes as the fallback. */
export function anchorFor(target: DebugTarget, fallback: string): string {
  if ("path" in target) return target.path;
  return "dir" in target ? target.dir : fallback;
}

/** How a target reads in the picker and in the pane. */
export function describeTarget(target: DebugTarget): string {
  switch (target.kind) {
    case "file":
      return basename(target.path);
    case "script":
      return `run ${target.script}`;
    case "attach":
      return `port ${target.port}`;
    case "module":
      return `-m ${target.module}`;
    case "pytest":
      return `pytest ${basename(target.path)}`;
    case "package":
      return `package ${basename(dirname(target.path))}`;
    case "test":
      return `tests in ${basename(dirname(target.path))}`;
    case "cargo":
      return target.bin;
    case "program":
      return basename(target.program);
  }
}

// --- what a target failing means -------------------------------------------

/**
 * Turn an attach failure into something actionable.
 *
 * A refused or timed-out connection to an inspector port has exactly one
 * common cause, and the adapter's own message does not name it: the target was
 * started without `--inspect`. A bare timeout sends people looking at firewalls.
 */
export function attachFailureMessage(port: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return (
    `Nothing is listening for a debugger on port ${port}. ` +
    `Start the process with \`node --inspect\` (or \`--inspect-brk\` to pause at its first line) and try again.` +
    (detail ? ` The adapter said: ${detail}` : "")
  );
}

// --- the remembered attach port --------------------------------------------

const LS_ATTACH_PORTS = "tori.debugAttachPorts";

/** Every workspace's last-used inspector port, keyed by branch-unit folder. */
export type AttachPortStore = Readonly<Record<string, number>>;

/** The port to offer for this workspace, defaulting to node's own. */
export function attachPortFor(store: AttachPortStore, ws: string): number {
  const port = store[ws];
  return isPort(port) ? port : DEFAULT_ATTACH_PORT;
}

/** Remember a port. Returns the same store when nothing changed, so a caller
 *  holding this in a signal does not re-run its effects on a no-op. */
export function setAttachPort(store: AttachPortStore, ws: string, port: number): AttachPortStore {
  if (!isPort(port) || store[ws] === port) return store;
  return { ...store, [ws]: port };
}

/** Whether a typed value is a port a debugger could be listening on. Rejects
 *  the privileged range: nothing runs `node --inspect` below 1024, and a typo
 *  there is a typo rather than a choice. */
export function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/** Parse a stored port map, keeping the well-formed entries. Pure and exported
 *  so the rules test without a DOM, the way `frecency.ts`'s `parseStore` is. */
export function parseAttachPorts(raw: string | null): AttachPortStore {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [ws, port] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPort(port)) out[ws] = port;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadAttachPorts(): AttachPortStore {
  try {
    return parseAttachPorts(localStorage.getItem(LS_ATTACH_PORTS));
  } catch {
    return {};
  }
}

export function saveAttachPorts(store: AttachPortStore): void {
  try {
    localStorage.setItem(LS_ATTACH_PORTS, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage costs the remembered port, nothing else.
  }
}

// --- the last target, so F5 is a repeat rather than a question --------------

const LS_LAST_TARGET = "tori.debugLastTarget";

/** What each workspace debugged, keyed by branch-unit folder: at most one
 *  target per adapter, the most recent first. */
export type LastTargetStore = Readonly<Record<string, readonly DebugTarget[]>>;

/** The target F5 repeats: `adapterId`'s last one, or with no adapter to go by,
 *  whatever the workspace ran most recently. */
export function lastTargetFor(
  store: LastTargetStore,
  ws: string,
  adapterId: string | null,
): DebugTarget | null {
  const targets = store[ws] ?? [];
  return (adapterId === null ? targets[0] : targets.find((t) => t.adapterId === adapterId)) ?? null;
}

export function setLastTarget(store: LastTargetStore, ws: string, target: DebugTarget): LastTargetStore {
  const others = (store[ws] ?? []).filter((t) => t.adapterId !== target.adapterId);
  return { ...store, [ws]: [target, ...others] };
}

/** Whether a parsed value is a target this build understands. Kept strict
 *  rather than trusting the stored shape: this is read back across releases,
 *  and a target from a build that knew a fourth kind must be ignored rather
 *  than launched as something it is not. */
function isTarget(value: unknown): value is DebugTarget {
  const t = value as DebugTarget | null;
  if (!t || typeof t !== "object") return false;
  const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
  if (t.adapterId === JS_ADAPTER) {
    if (t.kind === "file") return nonEmpty(t.path);
    if (t.kind === "script") return nonEmpty(t.script);
    if (t.kind === "attach") return isPort(t.port);
  }
  if (t.adapterId === PYTHON_ADAPTER) {
    if (t.kind === "file" || t.kind === "pytest") return nonEmpty(t.path);
    if (t.kind === "module") return typeof t.module === "string" && isModuleName(t.module);
  }
  if (t.adapterId === GO_ADAPTER) {
    if (t.kind === "package" || t.kind === "test") return nonEmpty(t.path);
  }
  if (t.adapterId === LLDB_ADAPTER) {
    if (t.kind === "cargo") return nonEmpty(t.dir) && nonEmpty(t.bin);
    if (t.kind === "program") return nonEmpty(t.program);
  }
  return false;
}

/** Parse a stored target map, keeping the entries this build understands. */
export function parseLastTargets(raw: string | null): LastTargetStore {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, DebugTarget[]> = {};
    for (const [ws, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A workspace used to keep one bare target, and every target then was
      // js-debug's.
      const listed = Array.isArray(value)
        ? value
        : [value && typeof value === "object" ? { ...value, adapterId: JS_ADAPTER } : value];
      const targets = listed
        .filter(isTarget)
        .filter((t, i, all) => all.findIndex((o) => o.adapterId === t.adapterId) === i);
      if (targets.length) out[ws] = targets;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadLastTargets(): LastTargetStore {
  try {
    return parseLastTargets(localStorage.getItem(LS_LAST_TARGET));
  } catch {
    return {};
  }
}

export function saveLastTargets(store: LastTargetStore): void {
  try {
    localStorage.setItem(LS_LAST_TARGET, JSON.stringify(store));
  } catch {
    // Costs the F5 shortcut its memory, nothing else.
  }
}
