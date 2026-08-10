// The Solid-facing view of the debug runs, and the console transcript.
//
// `dapSessions.ts` owns the live tree and speaks the protocol; it is plain
// module state, deliberately free of Solid so it can be driven by a test with
// no reactive root. This is the other half: a signal mirroring that tree and a
// signal holding the output, which the Debug pane renders and the editor's
// fallback effect reads.
//
// Same constraint as `diagnostics.ts`, and for the same reason: no runtime
// CodeMirror import may appear here. Editor imports this eagerly, so a value
// import from `@codemirror/*` would pull the editor's dependency graph into the
// startup chunk and defeat the lazy boundary around CodeEditor.

import { createSignal } from "solid-js";

import { debugRoots, debugSession, onDebugChange, type DapSession } from "./dapSessions";

/**
 * What a session is doing, as far as the pane is concerned.
 *
 * `terminated` is a real state rather than a synonym for gone: a child ends all
 * the time while its parent keeps running, and a worker that has finished
 * should say so rather than have its row vanish mid-read.
 */
export type SessionState = "idle" | "running" | "stopped" | "terminated";

/** One session as the pane renders it, with its subtree inline. */
export type DebugNode = {
  id: string;
  name: string;
  state: SessionState;
  children: DebugNode[];
};

/**
 * The categories a DAP `output` event can carry.
 *
 * `telemetry` is deliberately absent: it is the adapter reporting on itself to
 * its vendor, not program output, and showing it would put noise nobody asked
 * for in the middle of a program's stdout.
 */
export type OutputCategory = "stdout" | "stderr" | "console" | "important";

const SHOWN_CATEGORIES: OutputCategory[] = ["stdout", "stderr", "console", "important"];

export type ConsoleLine = {
  /** Monotonic, so the `<For>` has a stable key even when two lines match. */
  id: number;
  /** Which session produced it. A run with four sessions interleaves their
   *  output, and "which one said this" is most of the value. */
  session: string;
  sessionName: string;
  category: OutputCategory;
  text: string;
};

/**
 * A runaway program emits output faster than anyone reads it, and this store
 * lives as long as the app does. Past this the oldest lines go, which is the
 * bargain a terminal's scrollback already makes.
 *
 * Known limit: the pane renders these as plain rows with no virtualisation, so
 * a full transcript is a full cap's worth of DOM. Tolerable at this size and
 * worth revisiting when the REPL starts writing into the same list.
 */
export const MAX_CONSOLE_LINES = 5000;

const [tree, setTree] = createSignal<DebugNode[]>([]);
const [lines, setLines] = createSignal<ConsoleLine[]>([]);

/** Every live run, as a tree. Empty when nothing is being debugged. */
export const debugTree = tree;

/** The debug console transcript, oldest first. */
export const consoleLines = lines;

/** Whether anything is being debugged right now. What the pane's empty state
 *  and the editor's tab availability both ask. */
export function debugRunning(): boolean {
  return tree().length > 0;
}

// Explicitly observed states, keyed by session id rather than held on the
// `DapSession`, so the protocol layer stays unaware that anything renders it.
// Absent means "nothing has happened yet", which `stateOf` reads off the
// handshake instead.
const states = new Map<string, SessionState>();
const wired = new Set<string>();
let nextLineId = 1;

/**
 * Strip the control bytes out of text Sway did not author.
 *
 * Program output is written by whatever is being debugged, which is exactly the
 * class of text [[lesson_sanitize_text_you_did_not_author]] is about. Newlines
 * survive, because they are the console's structure rather than a control
 * effect; tabs become spaces; every other C0/C1 byte goes, so an ANSI escape or
 * a bracketed-paste terminator in a program's stdout renders as the characters
 * it is made of and cannot reframe anything downstream.
 */
export function sanitizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\p{Cc}/gu, (c) => (c === "\n" ? c : ""));
}

/** Drop the whole transcript. Called when a project switch takes its runs
 *  away, and when a new run replaces a finished one. */
export function clearDebugConsole(): void {
  setLines([]);
  nextLineId = 1;
}

/**
 * A session's state.
 *
 * Nothing observed yet means the handshake decides: a session is `idle` until
 * the adapter has answered `initialize`, which is the moment there is a program
 * to talk about at all.
 */
function stateOf(session: DapSession): SessionState {
  return states.get(session.handle.session) ?? (session.capabilities ? "running" : "idle");
}

function snapshot(): void {
  const build = (session: DapSession): DebugNode => ({
    id: session.handle.session,
    name: session.name,
    state: stateOf(session),
    children: session.children
      .map((id) => debugSession(id))
      .filter((c): c is DapSession => c !== null)
      .map(build),
  });
  setTree(debugRoots().map(build));
}

function setState(id: string, state: SessionState): void {
  states.set(id, state);
  snapshot();
}

/**
 * Append one `output` event's text.
 *
 * DAP delivers output as chunks rather than lines, so a chunk *can* end
 * mid-line and be shown as its own row. That is the deliberate side to err on:
 * buffering the tail until a newline arrives would hide a program that prints a
 * prompt and waits, and in practice js-debug emits one chunk per `console.log`
 * with the newline included, so the split is rare and cosmetic.
 */
function append(session: DapSession, category: OutputCategory, text: string): void {
  const clean = sanitizeOutput(text);
  if (!clean) return;
  // One trailing newline is the chunk's terminator, not an empty line.
  const body = clean.endsWith("\n") ? clean.slice(0, -1) : clean;
  const rows = body.split("\n").map((line, i) => ({
    id: nextLineId + i,
    session: session.handle.session,
    sessionName: session.name,
    category,
    text: line,
  }));
  nextLineId += rows.length;
  setLines((prev) => {
    const next = [...prev, ...rows];
    return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
  });
}

function wire(session: DapSession): void {
  const id = session.handle.session;
  if (wired.has(id)) return;
  wired.add(id);

  session.conn.on("output", (body) => {
    const b = (body ?? {}) as { category?: string; output?: string };
    if (b.category === "telemetry") return;
    const category = (b.category ?? "console") as OutputCategory;
    // An unknown category shows as console rather than being dropped: dropping
    // is reserved for `telemetry`, the one thing that is explicitly not program
    // output.
    append(session, SHOWN_CATEGORIES.includes(category) ? category : "console", b.output ?? "");
  });

  session.conn.on("stopped", (body) => {
    // Not the entry pause. `dapSessions` asks for that one so a source map has
    // time to resolve and continues straight through it; surfacing it would
    // flash a paused state nobody asked for at the start of every launch.
    if ((body as { reason?: string } | null)?.reason === "entry") return;
    setState(id, "stopped");
  });
  session.conn.on("continued", () => setState(id, "running"));
  // `dapSessions` drops the session from the tree on this same event, so this
  // state is observed only for the moment before the snapshot removes the row.
  // Recorded anyway, so the row's last frame reads "terminated" rather than
  // whatever it was doing when it ended.
  session.conn.on("terminated", () => setState(id, "terminated"));
}

function sync(): void {
  const live = new Set<string>();
  const walk = (session: DapSession) => {
    live.add(session.handle.session);
    wire(session);
    for (const id of session.children) {
      const child = debugSession(id);
      if (child) walk(child);
    }
  };

  const roots = debugRoots();
  // A run starting with nothing live before it is a new run, so the previous
  // one's output goes. Kept otherwise, so a finished run stays readable until
  // something replaces it.
  if (roots.length > 0 && wired.size === 0) clearDebugConsole();
  for (const root of roots) walk(root);

  for (const id of [...wired]) {
    if (live.has(id)) continue;
    wired.delete(id);
    states.delete(id);
  }
  snapshot();
}

// Mirrors `dapSessions`, from module load rather than from the pane mounting:
// the pane can open and close freely, and a run that started before it was
// first opened still has its transcript when it is.
onDebugChange(sync);

// And once now, rather than only on the next change. Subscribing alone would
// make this module's *import order* load-bearing: a run already live when it is
// first evaluated would never be wired, so its rows and its whole transcript
// would silently never appear. Editor imports this eagerly today, which is
// exactly the kind of guarantee a later entry point moves without noticing.
sync();
