// Whether the editor opens the most-recently-changed file as sessions edit.
//
// **A module-level signal, not a per-component one.** The control lives in the
// chat composer's bar now and the editor is what acts on it, so the two are in
// different panels; a signal per consumer would leave them disagreeing. Same
// shape as `blamePref.ts`, and for the same reason.
//
// Not persisted, unlike blame. Following takes the editor away from whatever
// you had open the moment a session touches a file, so it is a thing you switch
// on for an afternoon rather than a preference a launch should assume.
import { createSignal } from "solid-js";

const [followEdits, setFollowEdits] = createSignal(false);

/** The live setting. Every surface reads this rather than a copy of its own. */
export { followEdits, setFollowEdits };
