// A breakpoint's life outside the store: when it is sent, when it is not, and
// how it is ever known to have bound.
//
// `breakpoints.ts` owns the shape and the rules and knows nothing about a debug
// run. This is the other half, on the same split as `debugStore.ts` beside it: a
// Solid signal the gutter reads, plus the wire to `dapSessions`. Nothing here
// imports CodeMirror, for `diagnostics.ts`'s reason: Editor imports this
// eagerly, so a value import from `@codemirror/*` would pull the editor's
// dependency graph into the startup chunk.
//
// Three states, because "will this stop?" has three answers:
//
// - **pending**, the buffer has unsaved edits. The line the store holds refers
//   to text the adapter has never seen, so sending it would arm a line number
//   that means something else in the file on disk. Nothing is sent until the
//   save lands, and the save is also the moment the on-save pipeline
//   (`formatOnSave`, `organizeOnSave`) has finished moving lines around.
// - **armed**, sent, and the adapter has not said it bound. Phase 1 measured
//   `setBreakpoints` answering `verified: false, "provisionalBreakpoint"` during
//   the handshake for breakpoints that then bound and stopped, so this is the
//   normal state of a perfectly good breakpoint, not a warning.
// - **bound**, the adapter has said `verified: true` for that file and line.
//
// **Correlation is on path and line, never on `id`.** Measured against
// js-debug 1.117: two different breakpoints in one file both came back as
// `id: 1`, in the `setBreakpoints` response *and* in every `breakpoint` event.
// Trusting the id would flip the wrong marker.

import { createSignal } from "solid-js";

import {
  breakpointFiles,
  breakpointsFor,
  loadBreakpoints,
  mapBreakpointPaths,
  saveBreakpoints,
  setFileBreakpoints,
  toggleBreakpoint,
  type BreakpointStore,
} from "./breakpoints";
import { debugSessions, onDebugChange, setDebugBreakpointSource, type DapSession } from "./dapSessions";

/** What a marker in the gutter is saying. See the states above. */
export type BreakpointState = "pending" | "armed" | "bound";

/** One line and what it is currently doing, which is all the gutter renders. */
export type BreakpointMark = { line: number; state: BreakpointState };

const [store, setStore] = createSignal<BreakpointStore>(loadBreakpoints());

/** Bound lines as `path\nline`. A run's answer, not the reader's, so it is
 *  dropped when the run ends rather than persisted. */
const [bound, setBound] = createSignal<ReadonlySet<string>>(new Set());

/** Paths with unsaved edits. Kept here rather than read from the pane's own
 *  dirty map, because the answer is needed by the session-configuration seam
 *  below, which runs with no component in scope. */
const [dirty, setDirty] = createSignal<ReadonlySet<string>>(new Set());

const key = (path: string, line: number) => `${path}\n${line}`;
const lineOf = (k: string) => Number(k.slice(k.lastIndexOf("\n") + 1));

/** Every workspace's breakpoints. The pane reads through `breakpointMarks`; this
 *  is exported for the tests and for a future panel listing them all. */
export const breakpointStore = store;

function write(next: BreakpointStore): void {
  if (next === store()) return;
  setStore(next);
  saveBreakpoints(next);
}

/**
 * One file's lines with their current state, for the gutter.
 *
 * A dirty buffer makes every one of its breakpoints pending at once, including
 * ones that were bound a keystroke ago: the moment the file differs from what
 * the adapter was told, no line in it can be claimed to be armed.
 */
export function breakpointMarks(ws: string, path: string): BreakpointMark[] {
  const unsaved = dirty().has(path);
  const isBound = bound();
  return breakpointsFor(store(), ws, path).map((line) => ({
    line,
    state: unsaved ? "pending" : isBound.has(key(path, line)) ? "bound" : "armed",
  }));
}

/** Set or clear a breakpoint, from a click on the gutter. */
export function toggleBreakpointAt(ws: string, path: string, line: number): void {
  write(toggleBreakpoint(store(), ws, path, line));
  push(ws, path);
}

/**
 * An edit moved the breakpoints in an open buffer, so the store follows.
 *
 * The buffer is the authority only for the lines it holds. A file can be
 * shorter than it was when a breakpoint was set (a checkout, a revert), and the
 * buffer cannot report one past its own end, so those are carried across
 * untouched rather than deleted on the next keystroke.
 *
 * Nothing is sent from here. An edit that moved a breakpoint is exactly the case
 * where the buffer and the file on disk disagree, which is what `pending` is.
 */
export function breakpointsMoved(ws: string, path: string, lines: readonly number[], docLines: number): void {
  const beyond = breakpointsFor(store(), ws, path).filter((line) => line > docLines);
  write(setFileBreakpoints(store(), ws, path, [...lines, ...beyond]));
}

/**
 * A buffer became dirty, or was saved.
 *
 * The save side is what arms a pending breakpoint, and it is called *after* the
 * write, which is after `organizeOnSave` and `formatOnSave` have run. That
 * ordering is the point: both rewrite the file, the gutter's positions are
 * mapped through their edits and reported back through `breakpointsMoved`
 * before the write completes, so the line sent here is the line in the file that
 * is now on disk rather than the one that was in the buffer when you pressed
 * save.
 */
export function noteBufferDirty(ws: string, path: string, isDirty: boolean): void {
  const now = dirty();
  if (now.has(path) === isDirty) return;
  const next = new Set(now);
  if (isDirty) next.add(path);
  else next.delete(path);
  setDirty(next);
  if (!isDirty) push(ws, path);
}

/**
 * A file moved on disk, or is gone.
 *
 * The store follows, and so do the two run-scoped sets beside it: a bound key
 * naming the old path would keep a marker green on a file that no longer exists,
 * and a pending flag left on a trashed path would sit in the way of a name
 * somebody reuses later.
 *
 * Nothing is sent. A rename is not an edit, the adapter is holding the old
 * path's set either way, and the next session (or the next toggle) is what puts
 * that right; sending here would arm the new name against a target that never
 * heard of it.
 */
/** The workspace is gone: drop every breakpoint filed under it. */
export function dropWorkspaceBreakpoints(ws: string): void {
  if (!(ws in store())) return;
  const { [ws]: _gone, ...rest } = store();
  write(rest);
}

export function mapBreakpointFiles(map: (path: string) => string | null): void {
  write(mapBreakpointPaths(store(), map));
  setDirty(remap(dirty(), map));
  setBound(remapKeys(bound(), map));
}

/** Paths, rewritten or dropped. */
function remap(paths: ReadonlySet<string>, map: (path: string) => string | null): ReadonlySet<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const to = map(path);
    if (to !== null) out.add(to);
  }
  return out;
}

/** The same for `path\nline` keys, which have to be split and rebuilt. */
function remapKeys(keys: ReadonlySet<string>, map: (path: string) => string | null): ReadonlySet<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const at = k.lastIndexOf("\n");
    const to = map(k.slice(0, at));
    if (to !== null) out.add(`${to}${k.slice(at)}`);
  }
  return out;
}

/**
 * A buffer was closed.
 *
 * Its pending flag goes with it, and this is not cosmetic: a file closed with
 * unsaved edits would otherwise stay pending forever, silently left out of every
 * future run's configuration with no gutter left to say why.
 *
 * The lines armed may reflect edits the close discarded, since an edit moves
 * them as it happens. The alternative is a breakpoint that never fires again
 * and never explains itself.
 */
export function noteBufferClosed(ws: string, path: string): void {
  if (!dirty().has(path)) return;
  const next = new Set(dirty());
  next.delete(path);
  setDirty(next);
  push(ws, path);
}

/**
 * What a session sends when it configures itself.
 *
 * Dirty files are left out entirely: their line numbers describe a buffer the
 * adapter cannot see. They arrive on the next save like any other change.
 */
function armedFor(ws: string): Map<string, number[]> {
  const unsaved = dirty();
  const out = new Map<string, number[]>();
  for (const { path, lines } of breakpointFiles(store(), ws)) {
    if (unsaved.has(path)) continue;
    out.set(path, [...lines]);
  }
  return out;
}

/** Send one file's set to every live session of this workspace, and take what
 *  the answer says about binding. A file with none left still sends: an empty
 *  array is how DAP says "clear this file". */
function push(ws: string, path: string): void {
  if (dirty().has(path)) return;
  const lines = breakpointsFor(store(), ws, path);
  // A line this file no longer has cannot be bound. Without this, removing a
  // breakpoint and setting it again on the same line renders it filled at once,
  // claiming execution will stop there before the adapter has said anything.
  const stale = [...bound()].filter((k) => k.startsWith(`${path}\n`) && !lines.includes(lineOf(k)));
  if (stale.length) {
    const next = new Set(bound());
    for (const k of stale) next.delete(k);
    setBound(next);
  }
  for (const session of debugSessions()) {
    if (session.projectPath !== ws) continue;
    void session.conn
      .request<{ breakpoints?: unknown[] }>("setBreakpoints", {
        source: { path },
        breakpoints: lines.map((line) => ({ line })),
      })
      .then((body) => takeVerified(body?.breakpoints, path))
      .catch((e: unknown) => console.warn("setBreakpoints failed", path, e));
  }
}

/**
 * Read binding out of a `setBreakpoints` response.
 *
 * Only `verified: true` is taken. A `false` means nothing either way: during the
 * handshake js-debug answers `false` for every breakpoint, including ones that
 * bind moments later, so demoting on it would render every breakpoint
 * permanently unbound. Sent *while* a target is running it answers `true`
 * immediately, which is why this is read at all.
 */
function takeVerified(list: unknown[] | undefined, fallbackPath: string): void {
  if (!Array.isArray(list)) return;
  const next = new Set(bound());
  let changed = false;
  for (const entry of list) {
    const bp = (entry ?? {}) as { verified?: boolean; line?: number; source?: { path?: string } };
    if (bp.verified !== true || typeof bp.line !== "number") continue;
    const k = key(bp.source?.path ?? fallbackPath, bp.line);
    if (next.has(k)) continue;
    next.add(k);
    changed = true;
  }
  if (changed) setBound(next);
}

const wired = new Set<string>();

function wire(session: DapSession): void {
  const id = session.handle.session;
  if (wired.has(id)) return;
  wired.add(id);

  // The only route to bound state for a breakpoint that was sent during the
  // handshake, since that response is answered before the runtime exists and
  // always says `false`. js-debug re-sends the same event several times for one
  // breakpoint, so this has to be idempotent, which a set of keys is.
  session.conn.on("breakpoint", (body) => {
    const b = (body ?? {}) as {
      reason?: string;
      breakpoint?: { verified?: boolean; line?: number; source?: { path?: string } };
    };
    const path = b.breakpoint?.source?.path;
    const line = b.breakpoint?.line;
    if (typeof path !== "string" || typeof line !== "number") return;
    const k = key(path, line);
    const isBound = b.reason !== "removed" && b.breakpoint?.verified === true;
    const now = bound();
    if (now.has(k) === isBound) return;
    const next = new Set(now);
    if (isBound) next.add(k);
    else next.delete(k);
    setBound(next);
  });
}

function sync(): void {
  const live = debugSessions();
  for (const session of live) wire(session);
  const ids = new Set(live.map((s) => s.handle.session));
  for (const id of [...wired]) if (!ids.has(id)) wired.delete(id);
  // Nothing is running, so nothing is bound. Left standing, a green marker would
  // outlive the run that earned it and claim the next one had already bound.
  if (!live.length && bound().size) setBound(new Set<string>());
}

// Installed at module load, so a run that starts before any pane has opened
// still configures itself with the breakpoints that were set before it.
setDebugBreakpointSource(armedFor);
onDebugChange(sync);
// And once now, for `debugStore`'s reason: subscribing alone would make this
// module's import order load-bearing against a run that is already live.
sync();
