/**
 * The capacity probe, `TORI_RECIPE=capacity`. dev/capacity/run.mjs raises the
 * load from outside (sessions, projects, spaces, open files) while this
 * measures the same things on a loop until the driver ends the app: a warm A/B
 * worktree switch, a few tab clicks, and every frame gap in between. The two
 * sides never talk; the driver reads the rows back by timestamp against the
 * windows it logged for each step.
 *
 * Keep the window frontmost: an occluded window gets no frames, and every
 * switch times out into a row that reads slow when nothing was.
 */

import { clickTabs, enumerate, type Target, visit } from "./perfRecipe";
import { traceNote } from "./perfTrace";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BOOT_SETTLE_MS = 6000;
const CYCLE_GAP_MS = 1500;
const TAB_CLICKS = 2;
// One dropped frame at 60 Hz is noise; three in a row is a stutter a user sees.
const LONG_FRAME_MS = 50;
// The space the driver seeds with the two projects this loop flips between.
const PROBE_SPACE = "probe";
// Late enough that the driver has its sessions open and their tabs drawn.
const CENSUS_CYCLE = 8;

let started = false;
let gaps: number[] = [];
let lastFrame: number | null = null;

function watchFrames(): void {
  const tick = (now: number) => {
    if (lastFrame !== null) gaps.push(now - lastFrame);
    lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function framesSince(): Record<string, number> {
  const v = gaps.sort((a, b) => a - b);
  gaps = [];
  if (!v.length) return { frames: 0 };
  const at = (q: number) => Math.round(v[Math.min(v.length - 1, Math.floor(v.length * q))] * 10) / 10;
  return {
    frames: v.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: at(1),
    long: v.filter((g) => g > LONG_FRAME_MS).length,
  };
}

// A synchronous layout a script asked for, slower than this, is written down
// with where it came from: the frame cost no mark can see from outside.
const FORCED_LAYOUT_MS = 3;

function report(api: string, t0: number): void {
  const ms = performance.now() - t0;
  if (ms < FORCED_LAYOUT_MS) return;
  const stack = (new Error().stack ?? "")
    .split("\n")
    .slice(2, 8)
    .map((l) => l.trim());
  traceNote("forced-layout", { at: Date.now(), api, ms: Math.round(ms * 10) / 10, stack });
}

function watchForcedLayouts(): void {
  const methods: [object, string][] = [
    [HTMLElement.prototype, "focus"],
    [Element.prototype, "getBoundingClientRect"],
    [Element.prototype, "scrollTo"],
    [Element.prototype, "scrollIntoView"],
  ];
  for (const [proto, name] of methods) {
    const original = (proto as Record<string, (...a: unknown[]) => unknown>)[name];
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          report(name, t0);
        }
      },
    });
  }
  const getters: [object, string][] = [
    [HTMLElement.prototype, "offsetHeight"],
    [HTMLElement.prototype, "offsetWidth"],
    [HTMLElement.prototype, "offsetTop"],
    [Element.prototype, "scrollHeight"],
    [Element.prototype, "scrollTop"],
    [Element.prototype, "clientHeight"],
    [Element.prototype, "clientWidth"],
  ];
  for (const [proto, name] of getters) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc?.get) continue;
    const get = desc.get;
    Object.defineProperty(proto, name, {
      ...desc,
      get(this: unknown) {
        const t0 = performance.now();
        try {
          return get.call(this);
        } finally {
          report(name, t0);
        }
      },
    });
  }
}

/** A full relayout of the window, timed: one pixel off the root's width and back. */
function fullLayoutMs(): number {
  const root = document.documentElement;
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    root.style.width = `${innerWidth - 1}px`;
    const t0 = performance.now();
    void root.offsetHeight;
    runs.push(performance.now() - t0);
    root.style.width = "";
    void root.offsetHeight;
  }
  return runs.sort((a, b) => a - b)[2];
}

/** A full restyle, timed: an inherited custom property on the root changes, so
 *  every element's style is resolved again, then the layout after it. */
let restyles = 0;
function fullStyleMs(): number {
  const root = document.documentElement;
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    root.style.setProperty("--capacity-census", String(++restyles));
    const t0 = performance.now();
    void root.offsetHeight;
    runs.push(performance.now() - t0);
  }
  root.style.removeProperty("--capacity-census");
  void root.offsetHeight;
  return runs.sort((a, b) => a - b)[2];
}

/** Which region the layout cost lives in: each large subtree hidden in turn,
 *  the full relayout timed without it. */
function layoutCensus(): void {
  const label = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].slice(0, 2).join(".")}${Object.keys(
      (el as HTMLElement).dataset ?? {},
    )
      .slice(0, 2)
      .map((k) => `[${k}]`)
      .join("")}`;
  const all = fullLayoutMs();
  const style = fullStyleMs();
  const regions = [...document.body.querySelectorAll("*")].filter((el) => {
    const n = el.getElementsByTagName("*").length;
    return n > 150 && getComputedStyle(el).display !== "none";
  });
  const rows = regions
    .map((el) => {
      const h = el as HTMLElement;
      const was = h.style.display;
      h.style.display = "none";
      const without = fullLayoutMs();
      const unstyled = fullStyleMs();
      h.style.display = was;
      return {
        region: label(el),
        nodes: el.getElementsByTagName("*").length,
        saves: Math.round((all - without) * 10) / 10,
        styleSaves: Math.round((style - unstyled) * 10) / 10,
      };
    })
    .sort((a, b) => b.styleSaves - a.styleSaves)
    .slice(0, 15);
  void document.documentElement.offsetHeight;
  traceNote("layout-census", {
    at: Date.now(),
    fullMs: Math.round(all * 10) / 10,
    styleMs: Math.round(style * 10) / 10,
    nodes: document.getElementsByTagName("*").length,
    rows,
  });
}

/** Attribute changes on elements big enough that a selector keyed on them can
 *  restyle a large part of the window, which is what a switch should not do. */
function watchBroadMutations(): void {
  const label = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join(".")}`;
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      const nodes = el.getElementsByTagName("*").length;
      if (nodes < 300) continue;
      traceNote("broad-mutation", {
        at: Date.now(),
        target: label(el),
        nodes,
        attr: r.attributeName,
        was: r.oldValue?.slice(0, 80) ?? null,
        now: el.getAttribute(r.attributeName ?? "")?.slice(0, 80) ?? null,
      });
    }
  }).observe(document.documentElement, { attributes: true, attributeOldValue: true, subtree: true });
}

/** Time spent in the handlers of a focus change, which run inside the `focus()`
 *  that caused them. Each event's capture on window is stamped, so the gap to the
 *  next stamp is that event's handlers; `focusin` bubbling last closes the run. */
function watchFocusHandlers(): void {
  let run: [string, number][] = [];
  for (const type of ["blur", "focusout", "focus", "focusin"]) {
    addEventListener(type, () => run.push([type, performance.now()]), { capture: true });
  }
  addEventListener("focusin", (e) => {
    run.push(["end", performance.now()]);
    const total = run[run.length - 1][1] - run[0][1];
    if (total >= 2) {
      const el = e.target as Element | null;
      const target = el?.tagName ? `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join(".")}` : "window";
      const steps = run.slice(0, -1).map(([type, t], i) => `${type}:${Math.round((run[i + 1][1] - t) * 10) / 10}`);
      traceNote("focus-handlers", { at: Date.now(), ms: Math.round(total * 10) / 10, target, steps });
    }
    run = [];
  });
}

async function probeUnits(): Promise<Target[]> {
  return (await enumerate(Number.POSITIVE_INFINITY)).filter((u) => u.sel.spaceName === PROBE_SPACE);
}

export async function startCapacityRecipe(census = false): Promise<void> {
  if (started) return;
  started = true;
  traceNote("recipe-start", { spec: "capacity" });
  await sleep(BOOT_SETTLE_MS);
  watchFrames();
  watchForcedLayouts();
  watchFocusHandlers();
  if (census) watchBroadMutations();
  for (let cycle = 0; ; cycle++) {
    const units = await probeUnits();
    if (units.length >= 2) {
      await visit(units[0]);
      await visit(units[1]);
    } else {
      traceNote("capacity-wait", { why: `${units.length} units in the ${PROBE_SPACE} space, two needed` });
    }
    await clickTabs(TAB_CLICKS);
    if (census && cycle === CENSUS_CYCLE) layoutCensus();
    traceNote("capacity-probe", {
      at: Date.now(),
      cycle,
      dom: document.getElementsByTagName("*").length,
      ...framesSince(),
    });
    await sleep(CYCLE_GAP_MS);
  }
}
