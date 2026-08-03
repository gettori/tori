// Per-tab soft-wrap overrides: the rule, without the pane around it.
//
// A sibling of `purgeTabs.ts` and for the same reason: the interesting part is a
// small state transform Editor.tsx would otherwise hold inline, where it can
// only be tested by mounting the whole pane.
//
// **Three answers, not two.** A tab can be wrapped, be unwrapped, or have no
// opinion and follow `settings.editor.softWrap`. A `Set` of wrapped tab ids
// could not express the third, so a tab could never be handed back to the
// setting once it had been toggled away from it.

/** Tab id (which is the file path) to that tab's answer. Absent means the tab
 *  has no opinion. */
export type WrapOverrides = Readonly<Record<string, boolean>>;

/** What this tab is showing right now: its own answer, else the setting's. */
export function wrapShownFor(overrides: WrapOverrides, id: string, settingOn: boolean): boolean {
  return overrides[id] ?? settingOn;
}

/**
 * Flip one tab, starting from what it is currently showing.
 *
 * Starting from the *shown* value rather than from the stored one is what makes
 * the first toggle always visibly change something, whichever way the setting
 * points; starting from `overrides[id]` would make the first press a no-op for
 * any tab whose setting was already on.
 */
export function toggledWrap(overrides: WrapOverrides, id: string, settingOn: boolean): WrapOverrides {
  return { ...overrides, [id]: !wrapShownFor(overrides, id, settingOn) };
}

/** Drop a closed tab's answer. Returns the same object when there is nothing to
 *  drop, so a close that changes nothing here cannot retrigger a reconfigure. */
export function withoutTab(overrides: WrapOverrides, id: string): WrapOverrides {
  if (!(id in overrides)) return overrides;
  const next = { ...overrides };
  delete next[id];
  return next;
}
