// Where a paused program is, and the six buttons that move it.
//
// The third module on the split `debugStore.ts` established: `dapSessions.ts`
// owns the protocol and stays free of Solid, and this is the Solid-facing half
// for one question, "what is the program doing and where is it". No CodeMirror
// import, for `diagnostics.ts`'s reason: Editor imports this eagerly.
//
// A run pauses per *session*, not per run. Phase 1 measured a `pnpm test` run
// with 214 sessions across four levels, and the ones that stop are the leaves;
// the root never does. So the stack is a list of stopped sessions, each with its
// own frames, and a selected frame names both.

import { createSignal } from "solid-js";

import { debugRoots, debugSession, onDebugChange, type DapSession } from "./dapSessions";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "./events";
import { syntheticId } from "./syntheticTabs";

/** One frame, flattened out of DAP's `StackFrame` into what a row renders and
 *  what opening it needs. */
export type StackFrame = {
  /** DAP's own frame id, which every later request about this frame carries. */
  id: number;
  name: string;
  /** Absolute path, or null for a frame with no file on disk. */
  path: string | null;
  /** How the source reads in a list: a basename, or something like
   *  `<eval>/VM123` for code that was never a file. Normalized on the way in,
   *  because js-debug does not honour the "name" in `source.name`. */
  sourceName: string;
  /** Non-zero when the content has to be fetched with a `source` request
   *  because there is nothing on disk to open. */
  sourceReference: number;
  line: number;
  column: number;
};

/** One paused session. */
export type StoppedSession = {
  id: string;
  name: string;
  threadId: number;
  reason: string;
  frames: StackFrame[];
};

/** Which frame the pane is showing, across the whole tree. */
export type FrameRef = { session: string; frameId: number };

/** How deep a stack is asked for. Past this a stack is a scroll nobody reads,
 *  and a runaway recursion would otherwise fetch tens of thousands of frames
 *  before anything could be drawn. */
export const MAX_FRAMES = 50;

const [stops, setStops] = createSignal<readonly StoppedSession[]>([]);
const [selected, setSelected] = createSignal<FrameRef | null>(null);

/** Every paused session, in the order they stopped. Empty while the program is
 *  running. Arrival order rather than tree order, because it is append-only:
 *  the row you are reading cannot move under you when a third worker pauses. */
export const debugStops = stops;

/** The selected frame's reference, or null when nothing is paused. */
export const selectedFrame = selected;

/** Sources fetched with a `source` request, keyed by the synthetic tab id that
 *  shows them. A session's `sourceReference` dies with the session, so the text
 *  is kept rather than re-fetched: a tab left open after a run ends still reads
 *  as what was stepped through. */
const fetched = new Map<string, string>();

/** The text behind a `tori://dapsource` tab, or null if it was never fetched. */
export function debugSourceText(id: string): string | null {
  return fetched.get(id) ?? null;
}

/** The tab id of the frame currently being shown, when that frame's code has no
 *  file behind it. Null otherwise. What lets a fetched-source view tell "the
 *  program is paused in me" from "the program is paused in some other fetched
 *  source", which are the same thing to `currentFrame` alone. */
export function currentSourceTab(): string | null {
  const at = currentFrame();
  if (!at || at.frame.path || !at.frame.sourceReference) return null;
  return sourceTabId(at.stop.id, at.frame);
}

/** The synthetic id one fetched source opens under. Keyed by the session too:
 *  two runs hand out the same small reference numbers for different code, and a
 *  tab keyed on the number alone would show one run's source under another's
 *  name. */
function sourceTabId(sessionId: string, frame: StackFrame): string | null {
  const session = debugSession(sessionId);
  if (!session) return null;
  return syntheticId(
    "dapsource",
    session.projectPath,
    `${sessionId}:${frame.sourceReference}:${frame.sourceName}`,
  );
}

/** Whether the program is paused, which is what every step control asks. */
export function debugPaused(): boolean {
  return stops().length > 0;
}

/** The frame the pane is showing, with its session. */
export function currentFrame(): { stop: StoppedSession; frame: StackFrame } | null {
  const ref = selected();
  if (!ref) return null;
  const stop = stops().find((s) => s.id === ref.session);
  const frame = stop?.frames.find((f) => f.id === ref.frameId);
  return stop && frame ? { stop, frame } : null;
}

/**
 * Where the current frame is, for the editor's line highlight.
 *
 * Null for a frame with no file on disk: the highlight belongs on a buffer, and
 * a fetched source opens as its own view that highlights its own line.
 */
export function frameLocation(): { path: string; line: number } | null {
  const at = currentFrame();
  return at?.frame.path ? { path: at.frame.path, line: at.frame.line } : null;
}

/**
 * Whether a file is on the selected pause's stack.
 *
 * What tells a buffer that the paused program has anything to say about it. A
 * frame's names mean nothing in a file the program is not in, and answering
 * anyway is worse than answering nothing: the value is real, it just belongs to
 * a different `count` than the one being pointed at.
 */
export function fileOnStack(path: string): boolean {
  const ref = selected();
  if (!ref) return false;
  const stop = stops().find((s) => s.id === ref.session);
  return Boolean(stop?.frames.some((f) => f.path === path));
}

/** Show a frame, and open what it points at. */
export function selectFrame(session: string, frameId: number): void {
  setSelected({ session, frameId });
  const at = currentFrame();
  if (at) void openFrame(session, at.frame);
}

/**
 * Open the file a frame is in.
 *
 * A frame with a path is an ordinary open. A frame without one is code that has
 * no file on disk (a bundled dependency, an eval): its content comes back from
 * the adapter with a `source` request and opens as a read-only synthetic tab,
 * because there is no path any editor could read. A frame with neither is left
 * alone rather than opening something wrong.
 */
export async function openFrame(sessionId: string, frame: StackFrame): Promise<void> {
  if (frame.path) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: frame.path, line: frame.line });
    return;
  }
  if (!frame.sourceReference) return;
  const session = debugSession(sessionId);
  const id = sourceTabId(sessionId, frame);
  if (!session || !id) return;
  if (!fetched.has(id)) {
    try {
      const body = await session.conn.request<{ content?: string }>("source", {
        sourceReference: frame.sourceReference,
        source: { sourceReference: frame.sourceReference },
      });
      fetched.set(id, body?.content ?? "");
    } catch (e) {
      console.warn("source request failed", frame.sourceName, e);
      return;
    }
  }
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: id, line: frame.line });
}

/** The session a control acts on: the selected frame's, or the only paused one
 *  when nothing has been selected yet. */
function actingStop(): StoppedSession | null {
  const ref = selected();
  const paused = stops();
  return (ref && paused.find((s) => s.id === ref.session)) ?? paused[0] ?? null;
}

function send(command: string): void {
  const stop = actingStop();
  if (!stop) return;
  const session = debugSession(stop.id);
  if (!session) return;
  // Cleared here rather than on the adapter's answer: js-debug does emit
  // `continued`, but a step's own `stopped` can arrive first, and a stack left
  // standing in between is a frame highlight on a line the program has left.
  clearStop(stop.id);
  void session.conn.request(command, { threadId: stop.threadId }).catch((e: unknown) => {
    console.warn(`${command} failed`, session.name, e);
    // Refused, so the program never moved: it is still paused exactly where it
    // was. Put the stack back rather than leaving the pane claiming a running
    // program, which arms pause and disables every step against a program that
    // is going nowhere. Skipped if something has stopped since, which is the
    // newer truth.
    if (!debugSession(stop.id) || stops().some((s) => s.id === stop.id)) return;
    setStops((prev) => [...prev, stop]);
    if (!selected() && stop.frames.length) setSelected({ session: stop.id, frameId: stop.frames[0].id });
  });
}

export const continueDebug = () => send("continue");
export const stepOver = () => send("next");
export const stepIn = () => send("stepIn");
export const stepOut = () => send("stepOut");

/**
 * Pause the program.
 *
 * Sent to the leaf sessions rather than to the root: Phase 1 measured that the
 * root session never stops, and the leaves are where program code actually
 * runs. A run with several leaves (a test runner's workers) pauses all of them,
 * which is what "pause" means for a run that is several processes.
 */
export function pauseDebug(): void {
  for (const session of leafSessions()) {
    void session.conn
      .request<{ threads?: { id: number }[] }>("threads")
      .then((body) => {
        const thread = body?.threads?.[0];
        if (thread) return session.conn.request("pause", { threadId: thread.id });
      })
      .catch((e: unknown) => console.warn("pause failed", session.name, e));
  }
}

/** The sessions with no children of their own, which is where program code
 *  actually runs: Phase 1 measured the root session never stopping. What
 *  anything addressed at "the program" rather than at a frame has to pick
 *  from. */
export function leafSessions(): DapSession[] {
  const out: DapSession[] = [];
  const walk = (session: DapSession) => {
    const kids = session.children.map(debugSession).filter((s): s is DapSession => s !== null);
    if (!kids.length) out.push(session);
    for (const kid of kids) walk(kid);
  };
  for (const root of debugRoots()) walk(root);
  return out;
}

function clearStop(id: string): void {
  setStops((prev) => prev.filter((s) => s.id !== id));
  if (selected()?.session === id) setSelected(null);
}

/**
 * How a frame's source reads in a list.
 *
 * Measured against js-debug 1.117: `source.name` is the *absolute path* for a
 * frame with a file behind it, not the basename the field's own name implies.
 * Rendered raw that is a full path in a narrow column, and composed into a
 * message it is nine repetitions of the same directory. A name that is not a
 * path is left alone, because the ones that are not
 * (`<node_internals>/internal/modules/cjs/loader`, `<eval>/VM123`) are already
 * short and are unreadable with their prefix taken off.
 */
function shortSource(name: string): string {
  return name.startsWith("/") ? name.split("/").pop() || name : name;
}

function frameOf(raw: unknown): StackFrame {
  const f = (raw ?? {}) as {
    id?: number;
    name?: string;
    line?: number;
    column?: number;
    source?: { path?: string; name?: string; sourceReference?: number };
  };
  // A reference beats a path, which is DAP's own rule and not a preference:
  // "if sourceReference > 0 the content must be retrieved through the source
  // request, even if a path is specified". Measured against js-debug 1.117,
  // which sends node's own frames as
  // `path: "<node_internals>/internal/modules/cjs/loader"` *with*
  // `sourceReference: 720072378`. Reading the path first would open a tab on a
  // file that has never existed on any disk.
  const reference = f.source?.sourceReference ?? 0;
  return {
    id: f.id ?? 0,
    name: f.name ?? "(anonymous)",
    path: reference > 0 ? null : f.source?.path || null,
    sourceName: shortSource(f.source?.name || f.source?.path || "(unknown)"),
    sourceReference: reference,
    line: f.line ?? 1,
    column: f.column ?? 1,
  };
}

async function recordStop(session: DapSession, threadId: number, reason: string): Promise<void> {
  let frames: StackFrame[] = [];
  try {
    const body = await session.conn.request<{ stackFrames?: unknown[] }>("stackTrace", {
      threadId,
      startFrame: 0,
      levels: MAX_FRAMES,
    });
    frames = (body?.stackFrames ?? []).map(frameOf);
  } catch (e) {
    console.warn("stackTrace failed", session.name, e);
  }
  // Gone while the stack was in flight: a step that landed, or a stop the user
  // continued through before the answer came back.
  if (!debugSession(session.handle.session)) return;
  const stop: StoppedSession = {
    id: session.handle.session,
    name: session.name,
    threadId,
    reason,
    frames,
  };
  setStops((prev) => [...prev.filter((s) => s.id !== stop.id), stop]);
  // The first stop of a pause selects itself and opens where it is. Later stops
  // do not: several workers hitting the same breakpoint would otherwise take
  // turns yanking the editor to whichever answered last.
  if (!selected() && frames.length) selectFrame(stop.id, frames[0].id);
}

const wired = new Set<string>();

function wire(session: DapSession): void {
  const id = session.handle.session;
  if (wired.has(id)) return;
  wired.add(id);

  session.conn.on("stopped", (body) => {
    const stop = (body ?? {}) as { reason?: string; threadId?: number };
    // Tori asked for the entry pause itself and continues straight through it;
    // building a stack for it would flash a frame nobody asked to see.
    if (stop.reason === "entry" || typeof stop.threadId !== "number") return;
    void recordStop(session, stop.threadId, stop.reason ?? "pause");
  });
  session.conn.on("continued", () => clearStop(id));
  session.conn.on("terminated", () => clearStop(id));
}

function sync(): void {
  const live = new Set<string>();
  const walk = (session: DapSession) => {
    live.add(session.handle.session);
    wire(session);
    for (const child of session.children) {
      const kid = debugSession(child);
      if (kid) walk(kid);
    }
  };
  for (const root of debugRoots()) walk(root);

  for (const id of [...wired]) if (!live.has(id)) wired.delete(id);
  // A session that went away takes its stack with it, whether or not it said
  // `terminated` first: a project switch drops the whole tree at once.
  const kept = stops().filter((s) => live.has(s.id));
  if (kept.length !== stops().length) setStops(kept);
  if (selected() && !live.has(selected()!.session)) setSelected(null);
}

onDebugChange(sync);
// And once now, for `debugStore`'s reason: subscribing alone would make this
// module's import order load-bearing against a run that is already live.
sync();
