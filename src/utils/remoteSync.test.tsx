// The background fetch's schedule, on fake timers. What is asserted here is
// *when* `git_fetch_quiet` is called, never what it does: which containers are
// actually due is Rust's decision, and the floor this passes is the only part
// of that decision the frontend owns.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";

const calls: { minAgeSecs: number; only: string | null }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "git_fetch_quiet") calls.push(args as never);
    return Promise.resolve(null);
  },
}));

// A real Solid store, not a plain object with a getter: the scheduler re-arms by
// *tracking* this value, and a stub would answer every read without telling
// anyone it changed - which is exactly the bug this file has to be able to see.
const settingsMock = vi.hoisted(() => ({ set: (_: number) => {} }));
vi.mock("../panels/Settings/settingsStore", async () => {
  const { createStore } = await import("solid-js/store");
  const [settings, setSettings] = createStore({ git: { fetchEveryMinutes: 10 } });
  settingsMock.set = (n: number) => setSettings("git", "fetchEveryMinutes", n);
  return { settings };
});

const { startRemoteFetch } = await import("./remoteSync");

/** jsdom's `document.hidden` is a getter on the prototype, so it takes an own
 *  property to stand in for a minimised window. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** The scheduler arms inside an effect, so it needs an owner to be disposed
 *  with. Returns the teardown for both it and the root. */
function start(): () => void {
  let stop!: () => void;
  let disposeRoot!: () => void;
  createRoot((dispose) => {
    disposeRoot = dispose;
    stop = startRemoteFetch();
  });
  return () => {
    stop();
    disposeRoot();
  };
}

/** Let Solid flush the effect that arms the timer. */
const settle = () => Promise.resolve();

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  settingsMock.set(10);
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("the background fetch's schedule", () => {
  it("fetches on its interval and stops while the window is hidden", async () => {
    stop = start();
    await settle();
    // Nothing at arm time: startup already has enough to do, and the first
    // focus is a moment away anyway.
    expect(calls.length).toBe(0);

    vi.advanceTimersByTime(10 * 60_000);
    expect(calls.length).toBe(1);

    setHidden(true);
    vi.advanceTimersByTime(30 * 60_000);
    // A window nobody is looking at has no rows to keep fresh.
    expect(calls.length).toBe(1);

    setHidden(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls.length).toBe(2);
  });

  it("fetches when the window comes back, under a floor Rust enforces", async () => {
    stop = start();
    await settle();

    window.dispatchEvent(new Event("focus"));
    expect(calls).toEqual([{ minAgeSecs: 90, only: null }]);

    // The floor is a number handed to Rust, not a timer here, so a second
    // focus still calls: what it must not do is ask for a fetch with no floor.
    window.dispatchEvent(new Event("focus"));
    expect(calls.every((c) => c.minAgeSecs === 90)).toBe(true);
  });

  it("does nothing at all when the setting is off, on a timer or on focus", async () => {
    settingsMock.set(0);
    stop = start();
    await settle();

    vi.advanceTimersByTime(60 * 60_000);
    window.dispatchEvent(new Event("focus"));

    expect(calls).toEqual([]);
  });

  it("arms from the setting that arrives after it started, not the default", async () => {
    // `loadSettings` fills the store without emitting `SETTINGS_CHANGED`, so a
    // scheduler listening for that event would run the ten-minute default over
    // the top of somebody who had switched it off.
    stop = start();
    await settle();

    settingsMock.set(0);
    await settle();
    vi.advanceTimersByTime(60 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(calls).toEqual([]);
  });

  it("rebuilds the interval when the setting changes", async () => {
    stop = start();
    await settle();

    settingsMock.set(2);
    await settle();
    vi.advanceTimersByTime(2 * 60_000);
    // The new interval, not the old one.
    expect(calls.length).toBe(1);

    // Switching off has to take the running timer with it, or the old schedule
    // outlives the setting that asked for it.
    settingsMock.set(0);
    await settle();
    vi.advanceTimersByTime(60 * 60_000);
    expect(calls.length).toBe(1);
  });

  it("leaves no timer or listener behind when it is stopped", async () => {
    const off = start();
    await settle();
    off();

    vi.advanceTimersByTime(60 * 60_000);
    window.dispatchEvent(new Event("focus"));
    setHidden(false);

    expect(calls).toEqual([]);
  });
});
