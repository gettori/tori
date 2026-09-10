// Per-workspace pane layout (plan phase 5): one versioned envelope holding the
// pane tree and the focused pane, keyed by workspace (branch-unit folder).
// Module-level signals, the panel stores' precedent; App.tsx resets it at
// setup so its lifetime tracks the app shell.
//
// Everything read from storage passes sanitizeEnvelope first: a malformed
// tree, an unknown node kind, a broken depth or an all-hidden layout falls
// back to a freshly seeded envelope rather than crashing the shell. The
// stored value is never repaired in place; only focusedPaneId, whose loss is
// recoverable, is patched to a visible pane.
import { createSignal } from "solid-js";
import { deferredWrite } from "../utils/deferredWrite";
import { dockFocused } from "./dockStore";
import { pinRulesFor } from "./tabPlacement";
import {
  MAX_PANES,
  MAX_SPLIT_DEPTH,
  leaves,
  resolvePinPane,
  setPaneHidden,
  visibleLeaves,
  type PaneLeaf,
  type PaneNode,
} from "./paneLayout";

export type LayoutEnvelope = {
  version: 2;
  layout: PaneNode;
  focusedPaneId: string;
};

/** The envelope this build writes. Version 1 was the two-pane default every
 *  workspace was seeded with; rejecting it on load is the migration (phase 12),
 *  since a rejected envelope re-seeds as the single pane and every tab in it
 *  falls back to the pin rule, which now resolves to that one pane. */
const ENVELOPE_VERSION = 2;

const LS_PANES = "sway.panes.v1";

function validNode(n: unknown, depth: number, ids: Set<string>): boolean {
  if (!n || typeof n !== "object") return false;
  const node = n as Record<string, unknown>;
  if (typeof node.id !== "string" || node.id === "" || ids.has(node.id)) return false;
  ids.add(node.id);
  if (typeof node.size !== "number" || !Number.isFinite(node.size) || node.size < 0) return false;
  if (node.type === "pane") return typeof node.hidden === "boolean";
  if (node.type === "split") {
    if (depth > MAX_SPLIT_DEPTH) return false;
    if (node.dir !== "row" && node.dir !== "column") return false;
    if (!Array.isArray(node.children) || node.children.length < 2) return false;
    return node.children.every((c) => validNode(c, depth + 1, ids));
  }
  // An unknown node kind is a layout this build cannot draw; reject the whole
  // envelope rather than guess at what a future (or corrupted) shape meant.
  return false;
}

export function sanitizeEnvelope(raw: unknown): LayoutEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.version !== ENVELOPE_VERSION) return null;
  if (!validNode(v.layout, 1, new Set())) return null;
  const layout = v.layout as PaneNode;
  if (leaves(layout).length > MAX_PANES) return null;
  const vis = visibleLeaves(layout);
  if (vis.length === 0) return null;
  const focused =
    typeof v.focusedPaneId === "string" && leaves(layout).some((l) => l.id === v.focusedPaneId)
      ? (v.focusedPaneId as string)
      : vis[0].id;
  return { version: ENVELOPE_VERSION, layout, focusedPaneId: focused };
}

function loadAll(): Record<string, LayoutEnvelope> {
  const out: Record<string, LayoutEnvelope> = {};
  try {
    const raw = localStorage.getItem(LS_PANES);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return out;
    for (const [ws, env] of Object.entries(parsed as Record<string, unknown>)) {
      const ok = sanitizeEnvelope(env);
      if (ok) out[ws] = ok;
    }
  } catch {
    // ignore: an unreadable store seeds fresh
  }
  return out;
}

const [envelopes, setEnvelopes] = createSignal<Record<string, LayoutEnvelope>>(loadAll());

const envelopeWrite = deferredWrite(() => {
  try {
    localStorage.setItem(LS_PANES, JSON.stringify(envelopes()));
  } catch {
    // ignore
  }
});

/** Ask for the store write. Deferred off the click frame; see `deferredWrite`. */
export function persistEnvelopes() {
  envelopeWrite.schedule();
}

/** Land a pending write now: the quit path, and a suite reading back what a
 *  relaunch would load. */
export function flushEnvelopes() {
  envelopeWrite.flush();
}

/** The workspace's envelope, or the caller's seed when none is stored yet.
 *  Pure read: pair it with ensureEnvelope so the seed gets stored once. */
export function envelopeFor(ws: string, seed: () => LayoutEnvelope): LayoutEnvelope {
  return envelopes()[ws] ?? seed();
}

/** Drop a workspace's envelope outright: the key is gone, not empty. */
export function forgetWorkspace(ws: string) {
  if (!envelopes()[ws]) return;
  const { [ws]: _gone, ...rest } = envelopes();
  setEnvelopes(rest);
  persistEnvelopes();
}

export function ensureEnvelope(ws: string, seed: () => LayoutEnvelope) {
  if (envelopes()[ws]) return;
  setEnvelopes({ ...envelopes(), [ws]: seed() });
  persistEnvelopes();
}

/**
 * Apply a tree edit. `fn` returning null (a refused edit) or the same tree is
 * a no-op. Focus follows the tree: a focused pane that vanished or hid hands
 * focus to the first visible pane. Pass `persist: false` for high-frequency
 * edits (a divider drag) and commit once at the end.
 */
export function updateLayout(
  ws: string,
  fn: (root: PaneNode) => PaneNode | null,
  opts?: { persist?: boolean },
): boolean {
  const env = envelopes()[ws];
  if (!env) return false;
  const next = fn(env.layout);
  if (!next || next === env.layout) return false;
  const focusedLeaf = leaves(next).find((l) => l.id === env.focusedPaneId);
  // The all-hidden fallback covers edits the tree layer allows but this phase
  // never makes (closing the last visible pane while hidden ones remain).
  const focused =
    focusedLeaf && !focusedLeaf.hidden
      ? env.focusedPaneId
      : (visibleLeaves(next)[0] ?? leaves(next)[0]).id;
  setEnvelopes({ ...envelopes(), [ws]: { ...env, layout: next, focusedPaneId: focused } });
  if (opts?.persist !== false) persistEnvelopes();
  return true;
}

/** The workspace's tree, or null before the shell seeded one (a panel mounted
 *  outside it, which is every panel-only test). */
export function layoutRoot(ws: string): PaneNode | null {
  return envelopes()[ws]?.layout ?? null;
}

export function focusedPaneId(ws: string): string | null {
  return envelopes()[ws]?.focusedPaneId ?? null;
}

export function setFocusedPane(ws: string, paneId: string) {
  const env = envelopes()[ws];
  if (!env || env.focusedPaneId === paneId) return;
  if (!leaves(env.layout).some((l) => l.id === paneId)) return;
  setEnvelopes({ ...envelopes(), [ws]: { ...env, focusedPaneId: paneId } });
  persistEnvelopes();
}

// ---- Pane key routing ------------------------------------------------------

/** Two-pane key routing (plan phase 6): does the focused pane host this kind's
 *  pin side? True for terminal kinds when no envelope exists yet, so a panel
 *  mounted outside the app shell keeps its pre-pane behavior. */
export function kindPaneFocused(ws: string, kind: string): boolean {
  // The dock holds the keys, whichever workspace pane had them last.
  if (dockFocused()) return false;
  const env = envelopes()[ws];
  if (!env) return kind !== "file";
  return resolvePinPane(env.layout, kind, pinRulesFor(ws, kind))?.id === env.focusedPaneId;
}

/** Reveal the pane a kind pins to and hand it pane focus: the shared shape of
 *  every programmatic "take me to this tab" (sidebar session click,
 *  next-waiting, focus-session-tab). No envelope means no pane to reveal. */
export function revealKindPane(ws: string, kind: string) {
  const env = envelopes()[ws];
  if (!env) return;
  const pane = resolvePinPane(env.layout, kind, pinRulesFor(ws, kind));
  if (!pane) return;
  if (pane.hidden) updateLayout(ws, (root) => setPaneHidden(root, pane.id, false));
  setFocusedPane(ws, pane.id);
}

// ---- Tab focus recency -----------------------------------------------------
// Which tab of a kind was focused last, for the kind toggles. A session-local
// ordering, not persisted: after a relaunch every stamp is 0 and the toggles
// fall back to the pin default, which is also where every tab still is.

let focusSeq = 0;
const focusStamps = new Map<string, number>();

export function noteTabFocus(tabId: string) {
  focusStamps.set(tabId, ++focusSeq);
}

export function tabFocusStamp(tabId: string): number {
  return focusStamps.get(tabId) ?? 0;
}

// ---- Seeding ---------------------------------------------------------------

/**
 * What a workspace starts as (phase 12): one pane, whose strip holds every kind
 * together. A split is something the user asks for and keeps, so nothing here
 * makes one on their behalf.
 */
export function seedOnePane(): LayoutEnvelope {
  return {
    version: ENVELOPE_VERSION,
    layout: { type: "pane", id: "main", size: 100, hidden: false },
    focusedPaneId: "main",
  };
}

/** The two-pane layout Sway shipped with, kept for the suites and stories that
 *  are about two panes. `rightShare` is the editor's percent of the split;
 *  visibility carries over from the legacy layout, with its both-hidden
 *  repair. */
export function seedTwoPane(opts: {
  rightShare: number;
  showLeft: boolean;
  showRight: boolean;
}): LayoutEnvelope {
  const bothHidden = !opts.showLeft && !opts.showRight;
  const showLeft = bothHidden ? true : opts.showLeft;
  const showRight = bothHidden ? true : opts.showRight;
  const right = Math.min(99, Math.max(1, opts.rightShare));
  const mk = (id: string, size: number, hidden: boolean): PaneLeaf => ({
    type: "pane",
    id,
    size,
    hidden,
  });
  return {
    version: ENVELOPE_VERSION,
    layout: {
      type: "split",
      id: "root",
      dir: "row",
      size: 100,
      children: [mk("left", 100 - right, !showLeft), mk("right", right, !showRight)],
    },
    focusedPaneId: showLeft ? "left" : "right",
  };
}

// Called from App.tsx's setup, nowhere else: the shell mounts once per app
// run, so this keeps the model's lifetime what today's layout signals had
// (and gives repeated test mounts a fresh model without touching the tests).
export function resetPaneLayoutModel() {
  // Unrun rather than flushed: the state a pending write would carry is the
  // state this call is throwing away.
  envelopeWrite.cancel();
  setEnvelopes(loadAll());
  focusStamps.clear();
  focusSeq = 0;
}
