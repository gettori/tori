// Context windows for models Sway has no better source for.
//
// This is the **last** step of `contextWindowFor`, and it exists only for
// non-Claude ids. A Claude session reports its own window on every completed
// turn (`result.modelUsage`); a third-party catalogue's idea of the same number
// could only disagree with the agent that is actually running. Before that
// first turn a Claude session now has no window at all, and that is the intended
// answer rather than a gap for this to fill: the adapter's declared figure used
// to sit there and was wrong (200k for models the agent reports 1M for).
//
// The fetch is **lazy on a miss**, not eager at mount. It used to fire from
// `StatusStrip`'s body on every mount, which made "we do not call out for a
// Claude session" true by intention only: nothing would have failed if the call
// had been unconditional, because it always was. Now the one thing that starts
// it is a lookup with nowhere else to go, so the claim is checkable.
import { createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

const [modelCaps, setModelCaps] = createSignal<Record<string, number>>({});
let capsRequested = false;

function ensureModelCaps() {
  if (capsRequested) return;
  capsRequested = true;
  // Shape-checked rather than trusted, the same rule the other IPC-backed stores
  // apply: this store is read from a render path, so a reply that is not an
  // object has to cost the caps rather than throw through everything reading it.
  invoke<Record<string, number>>("model_context_caps")
    .then((caps) => setModelCaps(caps && typeof caps === "object" ? caps : {}))
    .catch(() => {});
}

/** Test-only: clear the once-per-run latch.
 *
 *  Needed because the latch is module state that outlives a test. Without it
 *  the *second* test to want caps never calls out, so "a Claude session makes
 *  no network call" passes whenever some earlier test happened to consume the
 *  latch first - a green assertion about test ordering rather than about the
 *  code. Found by regressing the fetch to eager and watching the wrong test
 *  fail. */
export function __resetModelCapsForTests() {
  capsRequested = false;
  setModelCaps({});
}

// Offline/unmatched fallback for non-Claude families. Values mirror OpenRouter
// so a network miss stays close to the truth; the first matching key wins.
//
// Claude's own families are deliberately absent. They used to be here ("sonnet
// and opus are 1M today, other Claudes 200k"), which was right for two models
// by luck and is the kind of guess that goes stale without anything failing.
const STATIC_CAPS: [string, number][] = [
  ["gemini", 1_000_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["qwen", 1_000_000],
  ["kimi", 262_144],
  ["moonshot", 262_144],
  ["deepseek", 131_072],
  ["minimax", 204_800],
];

// OpenRouter keys ids as `<vendor>/<model>`, so a bare id has to be matched
// against the tail of every key. Indexed once per caps payload rather than
// scanned per lookup: the resolver is read from a render path several times a
// frame, and the payload is a few hundred entries.
const byBareId = createMemo(() => {
  const index: Record<string, number> = {};
  for (const [key, cap] of Object.entries(modelCaps())) {
    index[key] = cap;
    const slash = key.lastIndexOf("/");
    if (slash !== -1) index[key.slice(slash + 1)] ??= cap;
  }
  return index;
});

/**
 * The window for a model no closer source knows one for, or null.
 *
 * Returns null for any Claude id without so much as looking: reaching here with
 * one means the session had not reported a window and the adapter declared
 * none, and inventing a number in that case is exactly what this ticket
 * removed.
 */
export function foreignWindow(id: string): number | null {
  const m = id.toLowerCase();
  if (m.includes("claude")) return null;
  ensureModelCaps();
  const caps = byBareId();
  // The API style writes dashes where OpenRouter writes dots (`qwen3-6` vs
  // `qwen3.6`), so both spellings are tried.
  const dotted = id.replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2");
  for (const cand of [id, dotted]) {
    if (caps[cand]) return caps[cand];
  }
  for (const [key, cap] of STATIC_CAPS) if (m.includes(key)) return cap;
  return null;
}
