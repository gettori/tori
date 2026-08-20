/**
 * Frontend half of the switch-latency instrumentation. Off unless the backend
 * was launched with `SWAY_TRACE` set, which it answers through `trace_config`,
 * because a release bundle has no devtools and no console to be told through.
 *
 * Two things are recorded. Every `invoke` gets a line with a correlation id,
 * the wall-clock moment JS asked and the moment it was answered; the backend
 * writes its own line for the same id, so queue wait (backend arrival minus JS
 * call) is a subtraction rather than a guess. And each switch gets a summary
 * line with two endpoints: paint, a double-rAF after the workspace flip, and
 * settled, a frame after both the tree listing and the git status have landed.
 *
 * Timestamps are wall clock (`performance.timeOrigin + performance.now()`) to
 * match the backend's epoch milliseconds; `performance.now()` alone shares no
 * origin with anything in Rust.
 */

import { invoke } from "@tauri-apps/api/core";
import { setInvokeRecorder } from "./tracedCore";

type SwitchKind = "worktree" | "tab";

/** What a worktree switch waits for before it counts as settled. A tab switch
 *  has no data leg: the buffers are already in memory, so it ends at paint. */
const WORKTREE_LEGS = ["tree", "git"] as const;
export type SettleLeg = (typeof WORKTREE_LEGS)[number];

/** A worktree with no git status to report, or a listing that fails, would
 *  otherwise hold a span open forever and swallow the next switch. */
const SETTLE_TIMEOUT_MS = 5000;

type InvokeRec = { id: number; name: string; call: number; dur: number };

/** A point on the switch path. The invoke lines say when the backend answered
 *  and when JS heard it, so a block on the main thread already shows up as a
 *  cluster of callbacks landing together; marks say which code the block was
 *  in, which no invoke can. */
type MarkRec = { name: string; at: number };

type Span = {
  kind: SwitchKind;
  key: string;
  start: number;
  paint: number | null;
  settled: number | null;
  legs: Set<string>;
  invokes: InvokeRec[];
  marks: MarkRec[];
  timer: ReturnType<typeof setTimeout>;
  /** Four paths reach `emit`, and a fired timer cannot be cleared: without
   *  this, a span that settles just as it times out writes two rows. */
  done: boolean;
};

let on = false;
let seq = 0;
let current: Span | null = null;
let lastKey = "";
const buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const wall = () => performance.timeOrigin + performance.now();
const round = (n: number) => Math.round(n * 100) / 100;

/** Two frames, because one only proves the mutation was applied, not that the
 *  compositor drew it. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function write(line: string): void {
  buffer.push(line);
  if (buffer.length >= 64) {
    flush();
    return;
  }
  if (flushTimer === null) flushTimer = setTimeout(flush, 250);
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!buffer.length) return;
  const lines = buffer.splice(0, buffer.length);
  void invoke("trace_write", { lines }).catch(() => {});
}

/** Ask the backend whether to instrument, and if so start recording invokes.
 *
 *  The recorder is handed to `tracedCore`, which the production build puts in
 *  front of `@tauri-apps/api/core` for every importer. That seam exists because
 *  the runtime one does not: `__TAURI_INTERNALS__.invoke` is a readonly
 *  property on a non-configurable global, so neither assigning to it nor
 *  shadowing the object it lives on is allowed. Both were tried first. */
export async function installTrace(): Promise<void> {
  if (on) return;
  let config: { enabled?: boolean; recipe?: string } | undefined;
  try {
    config = await invoke<{ enabled: boolean; dir: string; recipe: string }>("trace_config");
  } catch {
    return;
  }
  if (!config?.enabled) return;

  setInvokeRecorder((cmd, args) => {
    // The trace's own plumbing stays out of the trace: logging `trace_write`
    // would schedule the flush that logs the next one, forever.
    if (cmd === "trace_write" || cmd === "trace_config") return undefined;
    const id = ++seq;
    const call = wall();
    // Bound to the span open when the call was made, not when it answered: a
    // slow invoke can outlive its switch, and it belongs to the one it delayed.
    const span = current;
    return {
      args: tagged(args, id),
      done: () => {
        if (span) span.invokes.push({ id, name: cmd, call: round(call - span.start), dur: round(wall() - call) });
        write(`{"t":"invoke","id":${id},"name":${JSON.stringify(cmd)},"call":${call},"done":${wall()}}`);
      },
    };
  });

  on = true;
  // The dev server and the test run keep the real core module, so the recorder
  // is set but never consulted. Spans still work; the per-invoke breakdown is
  // a release-build reading, which is the profile every number is pinned to.
  report(true, "");

  // SIGTERM and a window close both skip `beforeunload`, so the buffer is kept
  // short-lived rather than trusted to a teardown that may not run.
  addEventListener("beforeunload", flush);
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // Only when asked. An ordinary traced run measures what the user does; the
  // driver exists to make the degraded state reproducible without one.
  if (config.recipe) {
    void import("./perfRecipe").then((m) => m.startRecipe(config.recipe as string));
  }
}

/** Says whether tracing came up, in the only place a release build can be
 *  told: there is no console to print it to. */
function report(ok: boolean, why: string): void {
  write(`{"t":"install","ok":${ok},"why":${JSON.stringify(why)}}`);
  flush();
}

/** The correlation id rides in the argument map. Tauri looks each declared
 *  argument up by name, so the extra key reaches no command; a raw body (bytes,
 *  not a map) has nowhere to put it and goes untagged. */
function tagged(args: unknown, id: number): unknown {
  if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) return args;
  if (args !== undefined && (typeof args !== "object" || args === null)) return args;
  return { ...(args as object), __swayTrace: id };
}

/** Open a span, answering whether one was opened. A worktree switch is armed
 *  here and painted by the effect that observes the flip; a tab switch has no
 *  such effect, so it arms its own. */
export function traceSwitchStart(kind: SwitchKind, key: string): boolean {
  if (!on) return false;
  if (kind === "worktree" && key === lastKey) return false;
  if (current) emit(current);
  const span: Span = {
    kind,
    key,
    start: wall(),
    paint: null,
    settled: null,
    legs: new Set(),
    invokes: [],
    marks: [],
    timer: setTimeout(() => emit(span), SETTLE_TIMEOUT_MS),
    done: false,
  };
  current = span;
  if (kind === "tab") afterPaint(() => tracePainted(span));
  return true;
}

/** The workspace flip has been applied to the DOM. */
export function tracePaint(): void {
  if (!on || !current) return;
  const span = current;
  afterPaint(() => tracePainted(span));
}

function tracePainted(span: Span): void {
  if (span.paint !== null) return;
  span.paint = round(wall() - span.start);
  // Only now is the worktree known to have changed. Committing the key at the
  // click would let a declined checkout guard suppress the retry that works.
  if (span.kind === "worktree") lastKey = span.key;
  if (span.kind === "tab") emit(span);
}

/** One half of "settled" has landed. Both halves plus a frame end the span. */
export function traceSettle(leg: SettleLeg, key: string): void {
  if (!on || !current || current.kind !== "worktree" || current.key !== key) return;
  const span = current;
  span.legs.add(leg);
  if (!WORKTREE_LEGS.every((l) => span.legs.has(l))) return;
  afterPaint(() => {
    if (span.settled === null) span.settled = round(wall() - span.start);
    emit(span);
  });
}

function emit(span: Span): void {
  if (span.done) return;
  span.done = true;
  clearTimeout(span.timer);
  if (current === span) current = null;
  write(
    `{"t":"switch","kind":${JSON.stringify(span.kind)},"key":${JSON.stringify(span.key)},` +
      `"start":${span.start},"paint":${span.paint},"settled":${span.settled},` +
      `"invokes":${JSON.stringify(span.invokes)},"marks":${JSON.stringify(span.marks)}}`,
  );
  flush();
  const waiting = waiters.splice(0, waiters.length);
  for (const w of waiting) w();
}

const waiters: (() => void)[] = [];

/** Resolves when the next span closes, or when `timeoutMs` is up. Armed by the
 *  recipe *before* it triggers a switch, so a switch that settles faster than
 *  the caller can await is not missed. */
export function nextSpan(timeoutMs = 8000): Promise<void> {
  if (!on) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const i = waiters.indexOf(fire);
      if (i >= 0) waiters.splice(i, 1);
      resolve();
    };
    const timer = setTimeout(fire, timeoutMs);
    waiters.push(fire);
  });
}

/** Stamp a point on the open switch, if there is one. Callers are seams on the
 *  switch path (a view attaching, a state swap, a pane adopting its hosts), not
 *  hot paths: a mark per keystroke would grow the span line without bound.
 *  Outside a switch this costs one comparison and drops the mark. */
export function traceMark(name: string): void {
  if (!on || !current) return;
  current.marks.push({ name, at: round(wall() - current.start) });
}

/** A free-form line, for what the recipe counted and which pass it was in. */
export function traceNote(name: string, data: Record<string, unknown>): void {
  if (!on) return;
  write(`{"t":"note","name":${JSON.stringify(name)},"data":${JSON.stringify(data)}}`);
  flush();
}

/** Drains the buffer, for a driver that is about to close the window. */
export function traceFlush(): void {
  flush();
}
