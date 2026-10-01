import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

// A WebGL context is a page-wide resource, not a per-terminal one. Chromium
// gives a page ~16 and starts evicting the oldest itself once past that, which
// is how a long session ends up with terminals permanently on the DOM renderer.
// So the cap is ours, it leaves headroom, and eviction is by least-recently
// visible rather than by visible-only: an A/B flip between two worktrees would
// otherwise churn a context per switch, taxing the exact path this exists for.
const CAP = 8;

// A live context holds three or more surfaces the size of its canvas (measured:
// 24 to 30 pane-sized surfaces for 8 contexts), so the count alone lets eight
// terminals on a large display keep over a gigabyte. Off-screen contexts share
// this many canvas pixels between them, about 250MB, and one always stays warm
// so an A/B flip still costs no context.
const WARM_PIXELS = 20_000_000;

// Three lost contexts is a GPU that will not hold this terminal. Stop
// re-attaching and let xterm keep the DOM renderer it already fell back to.
const MAX_LOSSES = 3;

/** What an attach returns: the addon to dispose, plus the canvases it put in
 *  the host, because disposing the addon does not release their GL contexts. */
type Handle = { dispose(): void; canvases: HTMLCanvasElement[] };

export type WebglAttach = (
  term: Terminal,
  host: HTMLElement,
  onLoss: () => void,
) => Handle | null;

export type WebglSlot = {
  /** This terminal is on screen: pin it, attach if it is not, and re-rank it. */
  reveal(): void;
  /** Off screen: unpinned, still attached until the cap says otherwise. */
  conceal(): void;
  /** The terminal is going away. */
  release(): void;
};

type Entry = {
  term: Terminal;
  host: HTMLElement;
  handle: Handle | null;
  pinned: boolean;
  /** Rank for eviction: when this entry was last revealed. */
  seq: number;
  losses: number;
  retry: ReturnType<typeof setTimeout> | undefined;
};

const realAttach: WebglAttach = (term, host, onLoss) => {
  try {
    const before = new Set(host.querySelectorAll("canvas"));
    const addon = new WebglAddon();
    addon.onContextLoss(onLoss);
    term.loadAddon(addon);
    const canvases = [...host.querySelectorAll("canvas")].filter((c) => !before.has(c));
    return { dispose: () => addon.dispose(), canvases };
  } catch {
    // WebGL unavailable: xterm keeps the DOM renderer.
    return null;
  }
};

let attachWebgl: WebglAttach = realAttach;

const entries = new Set<Entry>();
let clock = 0;
let created = 0;
let disposed = 0;

function liveCount(): number {
  let live = 0;
  for (const e of entries) if (e.handle) live++;
  return live;
}

function attach(e: Entry) {
  if (e.handle || e.losses >= MAX_LOSSES) return;
  const handle = attachWebgl(e.term, e.host, () => {
    // A dispose we asked for can fire this too: the renderer arms a 3s
    // restoration timer on `webglcontextlost` and never clears it. Only the
    // handle that is still ours is a loss we did not cause.
    if (e.handle !== handle) return;
    onLoss(e);
  });
  if (!handle) {
    // No WebGL here at all (or not any more). Count it like a loss so a machine
    // without WebGL2 pays three failed constructions over the session rather
    // than one per reveal, forever.
    e.losses++;
    return;
  }
  e.handle = handle;
  created++;
}

function detach(e: Entry) {
  const handle = e.handle;
  if (!handle) return;
  e.handle = null;
  // Disposing the addon unhooks the renderer and removes its canvas, but the GL
  // context lives on until that canvas is collected, which is exactly the leak
  // the cap exists to stop. Drop it by hand, while the canvas is still ours.
  for (const canvas of handle.canvases) {
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  handle.dispose();
  disposed++;
}

function onLoss(e: Entry) {
  e.losses++;
  detach(e);
  if (!e.pinned || e.losses >= MAX_LOSSES) return;
  e.retry = setTimeout(() => {
    e.retry = undefined;
    attach(e);
    evict();
  }, 0);
}

function canvasPixels(handle: Handle): number {
  let most = 0;
  for (const c of handle.canvases) most = Math.max(most, c.width * c.height);
  return most;
}

function evict() {
  for (;;) {
    let warm = 0;
    let warmPixels = 0;
    let victim: Entry | undefined;
    for (const e of entries) {
      if (!e.handle || e.pinned) continue;
      warm++;
      warmPixels += canvasPixels(e.handle);
      if (!victim || e.seq < victim.seq) victim = e;
    }
    // Every live context is on screen. Over the cap is the right answer then:
    // taking a context off a visible terminal is a visible regression.
    if (!victim) break;
    const over = liveCount() > CAP || (warm > 1 && warmPixels > WARM_PIXELS);
    if (!over) break;
    detach(victim);
  }
}

function cancelRetry(e: Entry) {
  if (e.retry !== undefined) clearTimeout(e.retry);
  e.retry = undefined;
}

/** Put one terminal under the cap. Nothing is attached until it is revealed. */
export function acquireWebgl(term: Terminal, host: HTMLElement): WebglSlot {
  const entry: Entry = {
    term,
    host,
    handle: null,
    pinned: false,
    seq: ++clock,
    losses: 0,
    retry: undefined,
  };
  entries.add(entry);
  return {
    reveal() {
      entry.pinned = true;
      entry.seq = ++clock;
      attach(entry);
      evict();
    },
    conceal() {
      entry.pinned = false;
      evict();
    },
    release() {
      entries.delete(entry);
      cancelRetry(entry);
      detach(entry);
    },
  };
}

/** The terminal whose xterm host sits inside `root`, or null. For the trace
 *  recipe's scrollback check, which needs the `Terminal` object and can reach
 *  no component closure: this module already holds every term/host pair, and a
 *  second registry would be a second thing to keep true. Works on a detached
 *  `root` too, which is the state a disposed pane leaves its surfaces in. */
export function terminalIn(root: HTMLElement): Terminal | null {
  for (const e of entries) if (root.contains(e.host)) return e.term;
  return null;
}

export function __webglStatsForTests(): { created: number; disposed: number; live: number } {
  return { created, disposed, live: liveCount() };
}

export function __setWebglAttachForTests(fn: WebglAttach | null) {
  attachWebgl = fn ?? realAttach;
}

export function __resetWebglForTests() {
  for (const e of entries) {
    cancelRetry(e);
    e.handle = null;
  }
  entries.clear();
  clock = 0;
  created = 0;
  disposed = 0;
}
