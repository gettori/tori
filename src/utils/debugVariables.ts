// What the paused program holds, and what one expression is worth.
//
// The fourth module on the split `debugStore.ts` established, and the one that
// asks the most of the adapter: `debugStack.ts` says where the program is, and
// this says what is in scope there. Same constraint as its siblings, no runtime
// CodeMirror import, because Editor pulls this in eagerly through the hover.
//
// Everything here is scoped to the *selected frame*. A variable read against a
// different frame than the one on screen is worse than no variable at all, so
// changing the selection drops the whole tree rather than reconciling it: the
// references it was built from belong to the frame that is gone.

import { createEffect, createRoot, createSignal, on } from "solid-js";

import { debugSession } from "./dapSessions";
import { currentFrame, selectedFrame } from "./debugStack";
import { sanitizeOutput } from "./debugStore";
import { refreshWatches } from "./debugWatch";

/** One scope of the selected frame: Locals, Closure, Global. */
export type VarScope = {
  /** Stable within one frame, which is all the expansion state has to survive. */
  key: string;
  name: string;
  variablesReference: number;
  /** The adapter warning that reading this is slow (Global usually is), so it
   *  is never expanded on our own initiative. */
  expensive: boolean;
  /** How many indexed children the adapter says it has, 0 when it did not say.
   *  What decides whether expanding it pages. */
  indexedVariables: number;
};

/** One variable row. */
export type VarRow = {
  key: string;
  name: string;
  value: string;
  type: string | null;
  /** Non-zero when this row has children to fetch. */
  variablesReference: number;
  /** How many indexed children the adapter says it has, 0 when it did not say. */
  indexedVariables: number;
  /** The container this row lives in, which is what `setVariable` names. A row
   *  knows its own reference, but the request is addressed to its parent. */
  parentReference: number;
};

/**
 * How many indexed children are asked for at a time.
 *
 * A long array is the case this exists for: asking for a 100000-element buffer
 * in one request makes the adapter serialise every element before anything can
 * be drawn, and nobody reads past the first screen. `supportsVariablePaging` in
 * `dapSessions.initializeArguments` is the claim this code makes true.
 */
export const VARIABLE_PAGE = 100;

/** What a container needs for its next page. */
type Paging = { reference: number; indexed: number; loaded: number };

const [scopes, setScopes] = createSignal<readonly VarScope[]>([]);
const [rows, setRows] = createSignal<ReadonlyMap<string, readonly VarRow[]>>(new Map());
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
// A signal rather than a plain Map, because the "show more" row is drawn from
// it: a page count the pane cannot see is a truncated list that says nothing.
const [paging, setPaging] = createSignal<ReadonlyMap<string, Paging>>(new Map());

function notePaging(key: string, page: Paging | null): void {
  const next = new Map(paging());
  if (page) next.set(key, page);
  else next.delete(key);
  setPaging(next);
}

/**
 * Which frame the tree currently describes.
 *
 * Bumped on every frame change, and every in-flight answer carries the value it
 * was asked under. A `variables` reply that lands after the program has stepped
 * describes a frame that no longer exists, and its references are already dead.
 */
let generation = 0;

/** The scopes of the selected frame. Empty while nothing is paused. */
export const debugScopes = scopes;

/** The children of one container, or an empty list if they have not been
 *  fetched. Absence and emptiness are the same to a reader, which is why
 *  `isVariablesBusy` exists separately. */
export function variableRows(key: string): readonly VarRow[] {
  return rows().get(key) ?? [];
}

/** Whether a container is showing its children. */
export function isVariableExpanded(key: string): boolean {
  return expanded().has(key);
}

/** Whether a container's fetch is in flight, so a slow adapter reads as slow
 *  rather than as empty. */
export function isVariablesBusy(key: string): boolean {
  return busy().has(key);
}

/** How many indexed children a container still has beyond what is shown. */
export function variableMore(key: string): number {
  const page = paging().get(key);
  if (!page) return 0;
  return Math.max(0, page.indexed - page.loaded);
}

/** Whether the adapter serving the selected frame accepts `setVariable`. */
export function canSetVariable(): boolean {
  const session = frameSession();
  return Boolean(session?.capabilities?.supportsSetVariable);
}

function frameSession() {
  const at = currentFrame();
  return at ? debugSession(at.stop.id) : null;
}

function markBusy(key: string, on: boolean): void {
  const next = new Set(busy());
  if (on) next.add(key);
  else next.delete(key);
  setBusy(next);
}

type RawVariable = {
  name?: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  indexedVariables?: number;
};

function rowOf(raw: unknown, parentKey: string, parentReference: number, index: number): VarRow {
  const v = (raw ?? {}) as RawVariable;
  // Both halves are the debuggee's own strings: a name is an object key and a
  // value is whatever its `toString` returned, so the same rule the console
  // already applies applies here ([[lesson_sanitize_text_you_did_not_author]]).
  const name = sanitizeOutput(v.name ?? "");
  return {
    // The index is in the key because names repeat: an array's children are all
    // called by their position, and two `0`s under different pages would
    // otherwise share one expansion state.
    key: `${parentKey}/${index}:${name}`,
    name,
    value: sanitizeOutput(v.value ?? ""),
    type: v.type || null,
    variablesReference: v.variablesReference ?? 0,
    indexedVariables: v.indexedVariables ?? 0,
    parentReference,
  };
}

async function requestVariables(args: Record<string, unknown>): Promise<unknown[]> {
  const session = frameSession();
  if (!session) return [];
  const body = await session.conn.request<{ variables?: unknown[] }>("variables", args);
  return body?.variables ?? [];
}

/**
 * Fetch a container's children, paging the indexed ones.
 *
 * Named and indexed children are asked for separately once paging is on,
 * because a `filter: "indexed"` request answers with the elements alone: an
 * array's `length` is a named child, and dropping it to page the elements would
 * lose the one property anyone reads off a long array.
 */
async function loadChildren(key: string, reference: number, indexed: number): Promise<void> {
  const at = generation;
  markBusy(key, true);
  try {
    let raw: unknown[];
    let page: Paging | null = null;
    if (indexed > VARIABLE_PAGE) {
      const named = await requestVariables({ variablesReference: reference, filter: "named" });
      // Between the two halves the program can step, and the second reference
      // would then belong to a frame that is gone.
      if (at !== generation) return;
      const chunk = await requestVariables({
        variablesReference: reference,
        filter: "indexed",
        start: 0,
        count: VARIABLE_PAGE,
      });
      raw = [...named, ...chunk];
      page = { reference, indexed, loaded: VARIABLE_PAGE };
    } else {
      raw = await requestVariables({ variablesReference: reference });
    }
    // Everything this answer produces lands together and only for the frame it
    // was asked under. Recording the page first would leave a "show more" count
    // behind for a key the next frame builds again from scratch, over children
    // it never fetched.
    if (at !== generation) return;
    notePaging(key, page);
    setRows(
      new Map(rows()).set(
        key,
        raw.map((v, i) => rowOf(v, key, reference, i)),
      ),
    );
  } catch (e: unknown) {
    console.warn("variables failed", key, e);
  } finally {
    if (at === generation) markBusy(key, false);
  }
}

/** Fetch the next page of a long container's indexed children. */
export async function loadMoreVariables(key: string): Promise<void> {
  const page = paging().get(key);
  if (!page || page.loaded >= page.indexed) return;
  const at = generation;
  markBusy(key, true);
  try {
    const raw = await requestVariables({
      variablesReference: page.reference,
      filter: "indexed",
      start: page.loaded,
      count: VARIABLE_PAGE,
    });
    if (at !== generation) return;
    const have = rows().get(key) ?? [];
    const more = raw.map((v, i) => rowOf(v, key, page.reference, have.length + i));
    notePaging(key, { ...page, loaded: page.loaded + VARIABLE_PAGE });
    setRows(new Map(rows()).set(key, [...have, ...more]));
  } catch (e: unknown) {
    console.warn("variables page failed", key, e);
  } finally {
    if (at === generation) markBusy(key, false);
  }
}

/**
 * Show or hide a container's children, fetching them the first time.
 *
 * Nothing is fetched on the stop itself: a pause in a test worker has three
 * scopes whose Global alone is thousands of entries, and none of it is on
 * screen until somebody asks. The `indexed` count comes from the row that was
 * clicked, because only the adapter's answer knows how long the thing is.
 */
export function toggleVariables(key: string, reference: number, indexed = 0): void {
  if (!reference) return;
  const next = new Set(expanded());
  if (next.has(key)) {
    next.delete(key);
    setExpanded(next);
    return;
  }
  next.add(key);
  setExpanded(next);
  if (!rows().has(key)) void loadChildren(key, reference, indexed);
}

/**
 * Write a new value into a variable.
 *
 * Returns null on success and the adapter's message on refusal, because a
 * rejected edit has to say why: "not available" and "invalid expression" are
 * different problems and only the adapter can tell them apart.
 */
export async function setVariableValue(row: VarRow, value: string): Promise<string | null> {
  const session = frameSession();
  if (!session) return "Nothing is paused.";
  const at = generation;
  try {
    // The response is the only fresh reading there is, so it is what the row
    // takes. Re-reading the container instead was tried and measured against
    // js-debug 1.117: after a write that `evaluate` confirms took (`count` ->
    // 42), the container still answers 3, and so does a *fresh* `scopes`
    // request. A scope's `variablesReference` is a snapshot of the pause, so
    // re-reading would replace a correct value with a stale one.
    const body = await session.conn.request<{
      value?: string;
      type?: string;
      variablesReference?: number;
    }>("setVariable", {
      variablesReference: row.parentReference,
      name: row.name,
      value,
    });
    if (at !== generation) return null;
    const parentKey = row.key.slice(0, row.key.lastIndexOf("/"));
    const siblings = rows().get(parentKey);
    if (!siblings) return null;
    const updated = siblings.map((r) =>
      r.key === row.key
        ? {
            ...r,
            value: sanitizeOutput(body?.value ?? value),
            type: body?.type || r.type,
            variablesReference: body?.variablesReference ?? 0,
          }
        : r,
    );
    // Whatever the old value contained is gone, so its children are a view of
    // something that no longer exists. Collapsed too, or the row would sit open
    // over a list nothing is going to fill.
    const next = new Map(rows()).set(parentKey, updated);
    next.delete(row.key);
    setRows(next);
    notePaging(row.key, null);
    const open = new Set(expanded());
    open.delete(row.key);
    setExpanded(open);
    // A watch has no event to tell it a write happened, and `evaluate` is the
    // one reading that is live after one (measured: the container still says 3
    // while `evaluate count` says 42). So this is exactly when a watch is most
    // out of date, and the only moment anything knows to say so.
    refreshWatches();
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Evaluate an expression in the selected frame.
 *
 * Null rather than an error for every "there is nothing to ask": a hover over a
 * running program, or over a word that is not a name here, is the normal case
 * and must not put anything on screen.
 */
export async function evaluateInFrame(
  expression: string,
  context = "hover",
): Promise<{ value: string; type: string | null } | null> {
  const at = currentFrame();
  const session = frameSession();
  if (!at || !session || !expression) return null;
  try {
    const body = await session.conn.request<{ result?: string; type?: string }>("evaluate", {
      expression,
      frameId: at.frame.id,
      context,
    });
    if (typeof body?.result !== "string") return null;
    return { value: sanitizeOutput(body.result), type: body.type || null };
  } catch {
    // A name that is not in scope is refused, and that is not a failure worth
    // logging once per hover.
    return null;
  }
}

function clear(): void {
  generation++;
  setPaging(new Map());
  setScopes([]);
  setRows(new Map());
  setExpanded(new Set<string>());
  setBusy(new Set<string>());
}

async function loadScopes(): Promise<void> {
  clear();
  const at = currentFrame();
  const session = frameSession();
  if (!at || !session) return;
  const mine = generation;
  try {
    const body = await session.conn.request<{ scopes?: unknown[] }>("scopes", {
      frameId: at.frame.id,
    });
    if (mine !== generation) return;
    setScopes(
      (body?.scopes ?? []).map((raw, i) => {
        const s = (raw ?? {}) as {
          name?: string;
          variablesReference?: number;
          expensive?: boolean;
          indexedVariables?: number;
        };
        return {
          key: `s${i}`,
          name: sanitizeOutput(s.name ?? "(scope)"),
          variablesReference: s.variablesReference ?? 0,
          expensive: s.expensive === true,
          indexedVariables: s.indexedVariables ?? 0,
        };
      }),
    );
  } catch (e: unknown) {
    console.warn("scopes failed", e);
  }
}

// One app-lifetime root, for `sessionActivity.ts`'s reason: the tree outlives
// any component reading it, and there is nothing to dispose short of the app
// closing. `defer` is deliberately absent, so a module imported while something
// is already paused loads that frame's scopes rather than waiting for the next
// selection ([[lesson_the_handshake_succeeded_and_the_feature_is_silent]]).
createRoot(() => {
  createEffect(on(selectedFrame, () => void loadScopes()));
});
