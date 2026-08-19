/**
 * The scripted degradation recipe: drives the app through a fixed sequence so
 * the slow state is reproducible and the baseline table is a measurement rather
 * than a memory of clicking around.
 *
 * Runs only when the backend was launched with both `SWAY_TRACE` and
 * `SWAY_RECIPE` (App imports `registerRecipeHost` unconditionally, so the
 * module is in the main chunk either way; nothing in it runs unasked). The spec
 * is `<worktrees>x<terminals>x<rounds>`, e.g.
 * `SWAY_RECIPE=6x4x3`: visit six worktrees, spawn four terminals in each, then
 * flip between two of them three times.
 *
 * Four passes, in this order, because each one leaves the state the next one
 * needs: first visits (cold), terminals (the multiplier), warm A/B flips (the
 * number the plan's target is about), tab clicks. Then the counts, then quit.
 *
 * Worktree switches go straight to the selection signal rather than through the
 * sidebar's `selectUnit`, so the recipe measures the switch and not the
 * checkout guard in front of it; for a worktree that guard is a no-op anyway.
 * Tab switches do go through the real strip, by clicking the tab element: the
 * strip's gesture guard asks whether a click is in flight on a `[role="tab"]`,
 * not whether it was trusted, so a synthetic click takes the same path a mouse
 * does.
 *
 * Keep the window frontmost for the whole run. `paint` and `settled` are
 * double-rAF measurements and an occluded window gets no frames, so every
 * switch times out and the report reads `paint: null` on rows that are fine.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitWith, OPEN_TERMINAL, type OpenTerminal } from "./events";
import { nextSpan, traceFlush, traceNote, traceSwitchStart } from "./perfTrace";

/** Only the fields the recipe reads. The full shapes live in LeftSidebar. */
type Unit = { label: string; folderPath: string; branch: string | null; kind: string };
type Config = {
  spaces: { name: string; projects: { name: string; path: string; branchUnits: Unit[] }[] }[];
};

/** What the recipe needs from the app: somewhere to put the selection. App
 *  registers it on mount, because `setSelected` is not otherwise reachable. */
export type RecipeHost = { select: (s: Record<string, unknown>) => void };

let host: RecipeHost | null = null;
let started = false;

export function registerRecipeHost(h: RecipeHost): void {
  host = h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Startup is still finishing when the frontend first paints (see the ~800ms
// median queue wait in a boot trace), and measuring through it would measure
// that instead of a switch.
const BOOT_SETTLE_MS = 6000;
// Between steps, so a pass is not measuring the tail of the previous one.
const GAP_MS = 1200;
// A shell tab has to mount and spawn before the next one is asked for.
const SPAWN_GAP_MS = 700;
// Long enough for `seq` to run and the hidden terminals to parse it.
const STREAM_MS = 5000;

export async function startRecipe(spec: string): Promise<void> {
  if (started) return;
  started = true;
  const [worktrees, terminals, rounds] = parse(spec);
  traceNote("recipe-start", { spec, worktrees, terminals, rounds });

  await sleep(BOOT_SETTLE_MS);
  for (let i = 0; i < 40 && !host; i++) await sleep(100);
  if (!host) {
    traceNote("recipe-abort", { why: "no host registered" });
    return quit();
  }

  const units = await enumerate(worktrees);
  traceNote("recipe-units", { count: units.length, paths: units.map((u) => u.unit.folderPath) });
  if (!units.length) {
    traceNote("recipe-abort", { why: "no branch units discovered" });
    return quit();
  }

  traceNote("pass", { name: "first-visit" });
  for (const u of units) await visit(u);

  traceNote("pass", { name: "terminals", perWorktree: terminals });
  for (const u of units) {
    await visit(u);
    for (let i = 0; i < terminals; i++) {
      spawnShell(u.unit.folderPath, i);
      await sleep(SPAWN_GAP_MS);
    }
  }
  // The canned stream is `seq`, seeded backend-once as the tab's `init`, so
  // every run replays the same bytes and a remount cannot double them.
  await sleep(STREAM_MS);
  traceNote("counts", { when: "after-terminals", ...counts() });

  traceNote("pass", { name: "warm-ab", rounds });
  for (let r = 0; r < rounds; r++) {
    await visit(units[0]);
    await visit(units[Math.min(1, units.length - 1)]);
  }

  traceNote("pass", { name: "tab-clicks" });
  await clickTabs(rounds * 4);

  // The degraded row: the same A/B flip with the pair's terminals all producing
  // output. A deterministic byte producer stands in for an agent, which would
  // make the run unreproducible; the switch pays for bytes, not their author.
  const pair = [units[0], units[Math.min(1, units.length - 1)]];
  traceNote("pass", { name: "stream-start" });
  for (const u of pair) {
    for (let i = 0; i < terminals; i++) stream(u.unit.folderPath, i);
  }
  await sleep(3000);
  traceNote("counts", { when: "streaming", ...counts() });

  traceNote("pass", { name: "warm-ab-streaming", rounds });
  for (let r = 0; r < rounds; r++) {
    await visit(pair[0]);
    await visit(pair[1]);
  }

  traceNote("counts", { when: "end", ...counts() });
  traceNote("recipe-done", {});
  await sleep(500);
  return quit();
}

/** `<worktrees>x<terminals>x<rounds>`; a missing or unparsable field falls back
 *  rather than aborting the run. */
function parse(spec: string): [number, number, number] {
  const n = spec.split("x").map((p) => Number.parseInt(p, 10));
  const at = (i: number, dflt: number) => (Number.isFinite(n[i]) && n[i] > 0 ? n[i] : dflt);
  return [at(0, 6), at(1, 4), at(2, 3)];
}

async function enumerate(limit: number): Promise<{ sel: Record<string, unknown>; unit: Unit }[]> {
  let cfg: Config;
  try {
    cfg = await invoke<Config>("get_config");
  } catch (e) {
    traceNote("recipe-abort", { why: `get_config failed: ${String(e)}` });
    return [];
  }
  const out: { sel: Record<string, unknown>; unit: Unit }[] = [];
  for (const space of cfg.spaces ?? []) {
    for (const project of space.projects ?? []) {
      for (const unit of project.branchUnits ?? []) {
        if (unit.kind === "incomplete") continue;
        out.push({
          unit,
          sel: {
            spaceName: space.name,
            projectName: project.name,
            projectPath: project.path,
            folderPath: unit.folderPath,
            branch: unit.branch ?? unit.label,
            projectKind: unit.kind,
          },
        });
      }
    }
  }
  return out.slice(0, limit);
}

async function visit(u: { sel: Record<string, unknown>; unit: Unit }): Promise<void> {
  // Armed before the trigger: a warm switch can settle inside the same task.
  const settled = nextSpan();
  // Re-selecting the worktree already shown opens no span, so there is nothing
  // to wait for and awaiting would burn the full timeout on a no-op.
  const opened = traceSwitchStart("worktree", u.unit.folderPath);
  host?.select(u.sel);
  if (opened) await settled;
  await sleep(GAP_MS);
}

function spawnShell(folderPath: string, i: number): void {
  emitWith<OpenTerminal>(OPEN_TERMINAL, {
    id: `recipe:${folderPath}:${i}`,
    title: `recipe ${i}`,
    cwd: folderPath,
    program: "",
    args: [],
    kind: "task",
    init: "seq 1 20000\n",
  });
}

/** Puts a terminal spawned earlier into an endless output loop, by typing at
 *  the prompt its `init` returned to. Reuses the existing tabs rather than
 *  spawning more, so the streaming row measures the same degraded state the
 *  rows before it did, with only the output added. */
function stream(folderPath: string, i: number): void {
  void invoke("pty_write", {
    id: `recipe:${folderPath}:${i}`,
    data: "while true; do seq 1 500; sleep 0.02; done\n",
  }).catch(() => {});
}

/** Clicks `count` tabs of a pane's strip, through the real strip so the measured
 *  path is the one a mouse takes. Scoped to `.unified-strip`: the editor's
 *  right-hand mode tabs are also `[role="tab"]`, and those are not tab
 *  switches. Re-queried every iteration, because activating a tab re-renders
 *  the strip and a node captured beforehand is detached by the next click. */
async function clickTabs(count: number): Promise<void> {
  const strip = () => [...document.querySelectorAll<HTMLElement>('.unified-strip [role="tab"]')];
  traceNote("tab-count", { tabs: strip().length });
  for (let i = 0; i < count; i++) {
    // The first tab that is not already selected: clicking the selected one is
    // a no-op the strip drops before it reaches the activation path.
    const next = strip().find((t) => t.getAttribute("aria-selected") !== "true");
    if (!next) break;
    const painted = nextSpan(4000);
    next.click();
    await painted;
    await sleep(300);
  }
}

/** The two multipliers the plan wants confirmed at runtime. Class names are
 *  CSS-module-hashed, so these match on a substring; the canvas count stands in
 *  for live WebGL contexts, which the platform will not report directly. */
function counts(): Record<string, number> {
  const q = (s: string) => document.querySelectorAll(s).length;
  return {
    terminalHosts: q('[class*="termHostWrap"]'),
    visibleTerminalHosts: q('[class*="termHostWrap"]:not([class*="hidden"])'),
    xtermCanvases: q(".xterm-screen canvas"),
    liveWebglContexts: liveWebglContexts(),
    tabs: q('[role="tab"]'),
  };
}

/** What the WebGL cap is actually capping. The canvas count above cannot say:
 *  an attached renderer puts two canvases in the host (its own and a 2d link
 *  layer), so the total moves for reasons other than a context appearing.
 *  `getContext` on a canvas that already has a 2d context answers null rather
 *  than making a second one, so nothing here creates the thing it counts. */
function liveWebglContexts(): number {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")];
  return canvases.filter((c) => {
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
    return !!gl && !gl.isContextLost();
  }).length;
}

async function quit(): Promise<void> {
  traceFlush();
  await sleep(400);
  // `destroy`, not `close`: close re-enters the editor's dirty-buffer confirm
  // and would hang on a dialog nobody can answer. Destroying the window leaves
  // the process up (PTY and chat hosts), so the backend is asked to exit too.
  await getCurrentWindow().destroy().catch(() => {});
  await invoke("trace_quit").catch(() => {});
}
