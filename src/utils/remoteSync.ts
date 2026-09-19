// When the background fetch runs.
//
// The schedule is here and the work is in Rust: `git_fetch_quiet` decides which
// containers are actually due, so every trigger below can fire freely and the
// floor sorts it out. That split is what lets focus and the interval coexist
// without either one having to know about the other.
//
// Focus matters more than the interval. Coming back to Tori after a colleague
// pushed is exactly when a branch row is stale, and waiting out the rest of a
// ten-minute tick to find out is the difference between a live surface and a
// decorative one. The floor is what stops that becoming a fetch per alt-tab.

import { createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { gitStateFor } from "./gitActions";
import { settings } from "../panels/Settings/settingsStore";

/** How recently a container must have been fetched for a trigger to be a no-op,
 *  in seconds. Focus and the interval land together often enough that without
 *  it every alt-tab near a tick was two sweeps. */
const FLOOR_SECS = 90;

const MS_PER_MINUTE = 60_000;

/**
 * Bring one root's container up to date now, unless it already is. Returns
 * whether it asked, which Rust alone could not tell a caller: it accepts every
 * call and drops the ones inside the floor.
 *
 * Not gated on `fetchEveryMinutes`. Off stops the schedule, the thing running
 * behind your back; a button you pressed is not that.
 */
export function fetchRootNow(root: string | null | undefined, now = Date.now() / 1000): boolean {
  if (!root) return false;
  const last = gitStateFor(root).lastFetch;
  if (last && last.at > 0 && now - last.at < FLOOR_SECS) return false;
  void invoke("git_fetch_quiet", { minAgeSecs: FLOOR_SECS, only: root }).catch(() => {});
  return true;
}

/**
 * The fetch a surface that merely *opened* may ask for, as opposed to one the
 * user pressed: quiet, and floored at the schedule's own cadence, because
 * anything fresher than that is exactly what the schedule already promises.
 *
 * Nothing at all when the schedule is off. "Off means off" covers a list that
 * filled itself as much as it covers the timer, and with the schedule off the
 * only honest way to reach the network is a button.
 */
export function fetchRootIfStale(root: string | null | undefined, now = Date.now() / 1000): boolean {
  const minutes = settings.git.fetchEveryMinutes;
  if (!root || minutes <= 0) return false;
  const floor = Math.max(minutes * 60, FLOOR_SECS);
  const last = gitStateFor(root).lastFetch;
  if (last && last.at > 0 && now - last.at < floor) return false;
  void invoke("git_fetch_quiet", { minAgeSecs: floor, only: root }).catch(() => {});
  return true;
}

/**
 * Start the background fetch, and return the teardown.
 *
 * Off means off: no interval *and* no fetch on focus. A setting that kept one
 * of the two would be a switch that does not switch, and the one it kept would
 * be the one nobody could see running.
 */
export function startRemoteFetch(): () => void {
  let timer: number | undefined;

  const minutes = () => settings.git.fetchEveryMinutes;
  const running = () => minutes() > 0;

  const sweep = () => {
    if (!running()) return;
    // Nothing is awaited and nothing is reported. A quiet fetch that fails is
    // the resting state of any repo behind a credential prompt, and the rows
    // read their own freshness off the events.
    void invoke("git_fetch_quiet", { minAgeSecs: FLOOR_SECS, only: null }).catch(() => {});
  };

  const disarm = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };

  // Rebuilt rather than adjusted, because the interval length is the thing that
  // changes and `setInterval` has no way to change it in place.
  const arm = () => {
    disarm();
    if (!running() || document.hidden) return;
    timer = window.setInterval(sweep, minutes() * MS_PER_MINUTE);
  };

  // A window nobody is looking at has no rows to keep fresh, and focus is about
  // to fire anyway the moment it comes back.
  const onVisibility = () => (document.hidden ? disarm() : arm());
  const onFocus = () => sweep();

  // Tracked, not an event. `loadSettings` writes the store without emitting
  // `SETTINGS_CHANGED`, so a listener would arm on the built-in default and
  // keep sweeping every ten minutes for somebody who had switched it off -
  // until their next save, and never for an edit made to the file by hand.
  createEffect(arm);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);

  return () => {
    disarm();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
  };
}
