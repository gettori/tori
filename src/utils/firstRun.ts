// Whether the first-run modal is on screen, and which part of it.
//
// The gate is the config, not a flag: Tori can open once it has a base folder
// and a space to show, and until then the modal is the app. Both halves come
// from the backend (`get_config` for the gate, `first_run_state` for whether
// the intro was seen), so a fresh launch shows nothing until both have
// answered rather than flashing the modal at an existing user whose config
// simply had not loaded.
//
// Reading the config here rather than through the sidebar: the sidebar's copy
// is a signal private to that component, and the modal has to know the answer
// before the sidebar has anything to draw.
import { createEffect, createRoot, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The slice of `ResolvedConfig` (src-tauri/src/config.rs) the modal reads. */
export type FirstRunSpace = {
  name: string;
  path: string;
  external: boolean;
  projects: { name: string; path: string }[];
};
export type FirstRunConfig = { roots: string[]; spaces: FirstRunSpace[] };

export type FirstRunView = "intro" | "setup" | "closed";

/** Everything the view derives from. Kept as a plain record so the rule is
 *  testable without a store behind it. */
export type FirstRunInputs = {
  /** Both backend answers have landed. Until then the modal stays shut. */
  loaded: boolean;
  introSeen: boolean;
  /** The gate was unmet at some point this session. Latched rather than read
   *  live, so creating the space inside the modal does not close it before
   *  the once-after-the-gate steps have run. */
  opened: boolean;
  /** Open Tori was pressed. Cleared again if the gate is lost. */
  finished: boolean;
};

/** A base folder is set and it holds at least one space. Pinned folders do not
 *  count: they make a space without a base folder, which is what the gate
 *  exists to guarantee. */
export function gateMet(config: FirstRunConfig | null): boolean {
  if (!config) return false;
  return config.roots.length > 0 && config.spaces.some((s) => !s.external);
}

export function deriveView(inputs: FirstRunInputs): FirstRunView {
  if (!inputs.loaded || inputs.finished || !inputs.opened) return "closed";
  return inputs.introSeen ? "setup" : "intro";
}

const [config, setConfig] = createSignal<FirstRunConfig | null>(null);
const [introSeen, setIntroSeen] = createSignal<boolean | null>(null);
const [opened, setOpened] = createSignal(false);
const [finished, setFinished] = createSignal(false);
const [metBefore, setMetBefore] = createSignal(false);

export { config as firstRunConfig };

export function firstRunView(): FirstRunView {
  return deriveView({
    loaded: config() !== null && introSeen() !== null,
    introSeen: introSeen() === true,
    opened: opened(),
    finished: finished(),
  });
}

/** Shorthand for "the modal is up", which is what the rest of the app checks
 *  to hold its own first-run-unfriendly behaviour (hotkeys, the update pill,
 *  the terminal restore offer). */
export function firstRunOpen(): boolean {
  return firstRunView() !== "closed";
}

createRoot(() => {
  createEffect(() => {
    if (config() === null) return;
    if (gateMet(config())) return void setMetBefore(true);
    setOpened(true);
    setFinished(false);
  });
});

export function firstRunGateLost(): boolean {
  return metBefore();
}

let requested = false;

export function ensureFirstRunLoaded() {
  if (requested) return;
  requested = true;
  void reloadFirstRunConfig();
  invoke<{ introSeen: boolean }>("first_run_state")
    .then((s) => setIntroSeen(s?.introSeen === true))
    .catch(() => {
      // Leave it null: the modal stays shut rather than opening on a guess.
    });
  void listen("config://changed", () => void reloadFirstRunConfig()).catch(() => {
    // The modal reloads after its own writes, so only a change made elsewhere
    // (Forget base folder, a hand edit) goes unseen.
  });
}

export async function reloadFirstRunConfig(): Promise<FirstRunConfig | null> {
  try {
    const c = await invoke<FirstRunConfig | null>("get_config");
    if (c && Array.isArray(c.roots) && Array.isArray(c.spaces)) setConfig(c);
    return config();
  } catch {
    return null;
  }
}

export async function markIntroSeen(): Promise<void> {
  setIntroSeen(true);
  await invoke("first_run_mark_intro_seen").catch(() => {
    // This session already moved past it; a failed write only shows it again
    // on the next launch.
  });
}

export function finishFirstRun() {
  setFinished(true);
  setOpened(false);
}
