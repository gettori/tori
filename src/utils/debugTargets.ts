// What "debug this" actually means, as a DAP launch or attach configuration.
//
// Every target belongs to one adapter, and each adapter offers its own kinds.
// js-debug's three are the three ways a Node program is already started: the
// file in front of you, a script the project declares, and a process somebody
// else started with `--inspect`. Everything here is pure: the caller supplies
// the resolved root, that root's directory listing and the launch environment,
// so every rule is testable without a workspace on disk.
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

export type DebugTarget =
  | { adapterId: typeof JS_ADAPTER; kind: "file"; path: string }
  | { adapterId: typeof JS_ADAPTER; kind: "script"; script: string }
  | { adapterId: typeof JS_ADAPTER; kind: "attach"; port: number };

export type TargetKind = DebugTarget["kind"];

/** A registered debug adapter, as much of a `dap_registry` row as the frontend
 *  reads. */
export type DapAdapterInfo = {
  id: string;
  label: string;
  /** Extension (dotless, lowercase) to the DAP `type`. */
  languages: Record<string, string>;
  childSessions: boolean;
};

/** The kinds each adapter offers, in picker order. An adapter the backend
 *  registers and this table does not name has none yet. */
const ADAPTER_KINDS: Readonly<Record<string, readonly TargetKind[]>> = {
  [JS_ADAPTER]: ["file", "script", "attach"],
};

export function kindsFor(adapterId: string): readonly TargetKind[] {
  return ADAPTER_KINDS[adapterId] ?? [];
}

export function defaultKind(adapterId: string, hasFile: boolean): TargetKind | null {
  const kinds = kindsFor(adapterId);
  return kinds.find((k) => hasFile || k !== "file") ?? kinds[0] ?? null;
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
};

/** The DAP `type` every target uses. js-debug drives every JS dialect through
 *  this one type; the registry maps extensions to it. */
export const NODE_DEBUG_TYPE = "pwa-node";

/** The default inspector port `node --inspect` binds. */
export const DEFAULT_ATTACH_PORT = 9229;

function basename(path: string): string {
  return path.split("/").pop() || path;
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

/** The config for one target, built by the rules of the adapter it runs under. */
export function configFor(target: DebugTarget, ctx: TargetContext): DebugConfig {
  switch (target.adapterId) {
    case JS_ADAPTER:
      return nodeConfigFor(target, ctx);
  }
}

function nodeConfigFor(target: DebugTarget, ctx: TargetContext): DebugConfig {
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
 *  A script and an attach have no file of their own, so they resolve against
 *  the root the picker was opened at, which the caller passes as the fallback. */
export function anchorFor(target: DebugTarget, fallback: string): string {
  return target.kind === "file" ? target.path : fallback;
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
  if (!t || typeof t !== "object" || t.adapterId !== JS_ADAPTER) return false;
  if (t.kind === "file") return typeof t.path === "string" && t.path.length > 0;
  if (t.kind === "script") return typeof t.script === "string" && t.script.length > 0;
  if (t.kind === "attach") return isPort(t.port);
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
