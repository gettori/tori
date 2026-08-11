// The evaluating half of the watch list.
//
// `watches.ts` owns what is watched, this owns what each one is worth right
// now. Split for `breakpoints.ts`/`debugBreakpoints.ts`'s reason: the rules
// about a list are testable without a debug run, and the wire is not.
//
// Every watch is re-read on every frame change, which is every stop and every
// step. That is what a watch is for, and it is also why `MAX_WATCHES` exists.

import { createEffect, createRoot, createSignal, on } from "solid-js";

import { debugSession } from "./dapSessions";
import { currentFrame, selectedFrame } from "./debugStack";
import { sanitizeOutput } from "./debugStore";
import {
  addWatch,
  loadWatches,
  moveWatch,
  removeWatch,
  saveWatches,
  watchesFor,
  type WatchStore,
} from "./watches";

/** One row of the watch list. */
export type WatchRow = {
  expression: string;
  /** The adapter's answer, or null when there is none yet. */
  value: string | null;
  type: string | null;
  /** Why there is no value. Rendered instead of the value, never instead of the
   *  row: a watch that vanishes when it stops resolving is a watch you cannot
   *  fix, because there is nothing left to click. */
  error: string | null;
  /** In flight, so a slow adapter reads as slow rather than as empty. */
  pending: boolean;
};

type Answer = { value: string | null; type: string | null; error: string | null; pending: boolean };

const [store, setStore] = createSignal<WatchStore>(loadWatches());
// Keyed by workspace *and* expression. `orders.length` means one thing in one
// worktree and nothing in another, so an answer keyed on the text alone would
// show one project's value in another project's list.
const [answers, setAnswers] = createSignal<ReadonlyMap<string, Answer>>(new Map());

const answerKey = (ws: string, expression: string) => `${ws}\n${expression}`;

/** Which pause the answers describe, so a reply that lands after a step is
 *  dropped rather than shown against the frame that replaced it. */
let generation = 0;

const PENDING: Answer = { value: null, type: null, error: null, pending: true };
const IDLE: Answer = { value: null, type: null, error: null, pending: false };

/** This workspace's watches, each with whatever is currently known about it. */
export function watchRows(ws: string): WatchRow[] {
  const known = answers();
  return watchesFor(store(), ws).map((expression) => ({
    expression,
    ...(known.get(answerKey(ws, expression)) ?? IDLE),
  }));
}

/** The workspace the paused frame belongs to, which is the only one anything
 *  can be evaluated against. Null when nothing is paused. */
function pausedWorkspace(): string | null {
  const frame = currentFrame();
  const session = frame ? debugSession(frame.stop.id) : null;
  return session?.projectPath ?? null;
}

/** Whether anything can be evaluated at all, which is what the pane's "start a
 *  run" hint asks. */
export function watchesLive(): boolean {
  return currentFrame() !== null;
}

function write(next: WatchStore): void {
  if (next === store()) return;
  setStore(next);
  saveWatches(next);
}

/** Add an expression, and answer it at once if this workspace is the one that
 *  is paused: a watch that stays blank until the next step reads as broken, and
 *  one answered against another project's frame reads as worse than blank. */
export function addWatchExpression(ws: string, expression: string): void {
  const before = store();
  write(addWatch(before, ws, expression));
  const added = watchesFor(store(), ws).find((e) => !watchesFor(before, ws).includes(e));
  if (added && pausedWorkspace() === ws) void evaluate(ws, added, generation);
}

export function removeWatchExpression(ws: string, index: number): void {
  const gone = watchesFor(store(), ws)[index];
  write(removeWatch(store(), ws, index));
  if (gone) forget(ws, gone);
}

export function moveWatchExpression(ws: string, from: number, to: number): void {
  write(moveWatch(store(), ws, from, to));
}

function forget(ws: string, expression: string): void {
  const next = new Map(answers());
  if (!next.delete(answerKey(ws, expression))) return;
  setAnswers(next);
}

function note(ws: string, expression: string, answer: Answer, at: number): void {
  if (at !== generation) return;
  setAnswers(new Map(answers()).set(answerKey(ws, expression), answer));
}

async function evaluate(ws: string, expression: string, at: number): Promise<void> {
  const frame = currentFrame();
  const session = frame ? debugSession(frame.stop.id) : null;
  if (!frame || !session) return;
  note(ws, expression, PENDING, at);
  try {
    const body = await session.conn.request<{ result?: string; type?: string }>("evaluate", {
      expression,
      frameId: frame.frame.id,
      // `watch` rather than `hover`: adapters format for the surface they are
      // told about, and js-debug's watch rendering is the one that expands an
      // object rather than truncating it to one line.
      context: "watch",
    });
    note(
      ws,
      expression,
      {
        value: sanitizeOutput(body?.result ?? ""),
        type: body?.type || null,
        error: null,
        pending: false,
      },
      at,
    );
  } catch (e: unknown) {
    // The message, not a blank: "not available" and "x is not defined" are
    // different problems and the row is the only place either one can be read.
    note(
      ws,
      expression,
      { value: null, type: null, error: e instanceof Error ? e.message : String(e), pending: false },
      at,
    );
  }
}

/**
 * Re-read every watch of the workspace being debugged.
 *
 * Hangs off the frame changing, which is every stop and every step, and is also
 * called after a `setVariable`: Phase 8 measured that a scope's container is a
 * snapshot of the pause and still reports the pre-write value, while `evaluate`
 * answers the truth. So a write is exactly when a watch is most out of date and
 * has no event to say so.
 */
export function refreshWatches(): void {
  generation++;
  const at = generation;
  const ws = pausedWorkspace();
  if (!ws) {
    // Nothing is paused (or its session has gone), so nothing is knowable.
    // Held rather than cleared would show the values from two steps ago as if
    // they were current.
    setAnswers(new Map());
    return;
  }
  // Only the workspace being debugged: the paused frame cannot answer for any
  // other one.
  for (const expression of watchesFor(store(), ws)) void evaluate(ws, expression, at);
}

// One app-lifetime root, for `sessionActivity.ts`'s reason: the list outlives
// any component reading it. No `defer`, so a module imported while something is
// already paused answers that frame rather than waiting for the next one.
createRoot(() => {
  createEffect(on(selectedFrame, () => refreshWatches()));
});
