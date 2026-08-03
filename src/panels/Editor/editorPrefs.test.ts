import { describe, it, expect } from "vitest";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import { editorPrefExtensions } from "./editorPrefs";
import type { EditorPrefs } from "../Settings/settingsStore";

// A literal rather than `DEFAULT_SETTINGS.editor`: this is a `unit` (node) test,
// and importing the store for real runs its module body, which reads
// `localStorage` for the zoom level. The type still comes from the store, so a
// renamed key fails here.
const PREFS: EditorPrefs = {
  indentGuides: true,
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: true,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  wordCompletion: true,
  hotExit: true,
};

// A stand-in for whatever a phase puts in the compartment: present or absent is
// all this file cares about, and a real extension would tie these tests to one
// feature's semantics rather than to the reconciliation rule they exist for.
const marker = StateField.define<boolean>({ create: () => true, update: (v) => v });
const isOn = (s: EditorState) => s.field(marker, false) === true;

/** What the prefs compartment holds: whatever the module resolves today, plus a
 *  stand-in for the entry a later phase adds when the preference is on. */
const prefsWith = (on: boolean) => [...editorPrefExtensions(PREFS), ...(on ? [marker] : [])];

// The reason `swapTo` re-syncs rather than trusting the compartment: a
// reconfigure dispatches into the *active* state only. A buffer sitting in the
// background keeps whatever config it was built with, however long ago that
// was, so switching a preference while another file is open would otherwise
// leave that file on the old setting until it was closed and reopened.
describe("a buffer stashed while a preference changed", () => {
  function build(on: boolean) {
    const conf = new Compartment();
    const state = EditorState.create({ doc: "one\ntwo", extensions: [conf.of(prefsWith(on))] });
    return { conf, state };
  }

  it("keeps the config it was built with while it is in the background", () => {
    const stashed = build(true);
    const active = build(true);

    // The user turns the preference off while `active` is the shown buffer.
    const off = active.state.update({ effects: active.conf.reconfigure(prefsWith(false)) }).state;

    expect(isOn(off)).toBe(false);
    expect(isOn(stashed.state)).toBe(true); // untouched, and that is the bug's shape
  });

  it("picks the current value up when it is swapped back in", () => {
    const stashed = build(true);

    // What `swapTo` does after `view.setState(buf.state)`: re-resolve and
    // reconfigure, so the buffer lands on the preference as it is *now*.
    const swappedIn = stashed.state.update({ effects: stashed.conf.reconfigure(prefsWith(false)) }).state;

    expect(isOn(swappedIn)).toBe(false);
  });

  it("goes the other way too: built while off, swapped in while on", () => {
    const stashed = build(false);
    expect(isOn(stashed.state)).toBe(false);

    const swappedIn = stashed.state.update({ effects: stashed.conf.reconfigure(prefsWith(true)) }).state;

    expect(isOn(swappedIn)).toBe(true);
  });
});
