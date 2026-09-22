import { describe, it, expect } from "vitest";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import { activeEditorFeatures, editorPrefExtensions } from "./editorPrefs";
import type { EditorDefaults } from "../Settings/settingsStore";

// A literal rather than `DEFAULT_SETTINGS.editor`: this is a `unit` (node) test,
// and importing the store for real runs its module body, which reads
// `localStorage` for the zoom level. The type still comes from the store, so a
// renamed key fails here.
const PREFS: EditorDefaults = {
  // Part of the type, not of this pass: neither resolves to a live extension.
  formatOnSave: false,
  organizeImportsOnSave: false,
  codeActionsOnSave: false,
  codeLens: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  vimMode: false,
  tabSize: 2,
  insertSpaces: true,
  indentGuides: true,
  activeLineHighlight: "all",
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: true,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  stickyScroll: false,
  wordCompletion: true,
  hotExit: true,
  compactFolders: true,
  todoPatterns: "TODO,FIXME,HACK,XXX",
};

// A stand-in for whatever a phase puts in the compartment: present or absent is
// all this file cares about, and a real extension would tie these tests to one
// feature's semantics rather than to the reconciliation rule they exist for.
const marker = StateField.define<boolean>({ create: () => true, update: (v) => v });
const isOn = (s: EditorState) => s.field(marker, false) === true;

/** What the prefs compartment holds: whatever the module resolves today, plus a
 *  stand-in for the entry a later phase adds when the preference is on. */
const prefsWith = (on: boolean) => [...editorPrefExtensions(PREFS), ...(on ? [marker] : [])];

const withPrefs = (over: Partial<EditorDefaults>): EditorDefaults => ({ ...PREFS, ...over });

// Every switch false, derived rather than written out, so a preference added to
// the type later starts off here instead of quietly joining every expectation
// below. A setting that is not a switch keeps its default unless it has a real
// "off" to be put in: `todoPatterns` is a list of tags and `false` is not one,
// while `activeLineHighlight` spells its own.
const ALL_OFF = {
  ...Object.fromEntries(Object.entries(PREFS).map(([k, v]) => [k, typeof v === "boolean" ? false : v])),
  activeLineHighlight: "none",
} as EditorDefaults;
const only = (over: Partial<EditorDefaults>): EditorDefaults => ({ ...ALL_OFF, ...over });

describe("which comfort features a buffer gets", () => {
  it("turns each one on from its own key, and nothing else", () => {
    expect(activeEditorFeatures(only({ indentGuides: true }))).toEqual(["indentGuides"]);
    expect(activeEditorFeatures(only({ softWrap: true }))).toEqual(["softWrap"]);
    expect(activeEditorFeatures(only({ renderWhitespace: true }))).toEqual(["renderWhitespace"]);
    expect(activeEditorFeatures(only({ scrollPastEnd: true }))).toEqual(["scrollPastEnd"]);
  });

  it("gives an all-off block nothing at all", () => {
    expect(activeEditorFeatures(ALL_OFF)).toEqual([]);
    expect(editorPrefExtensions(ALL_OFF)).toEqual([]);
  });

  it("resolves one extension per active feature", () => {
    const all = withPrefs({
      indentGuides: true,
      softWrap: true,
      renderWhitespace: true,
      scrollPastEnd: true,
    });
    expect(editorPrefExtensions(all)).toHaveLength(activeEditorFeatures(all).length);
  });
});

// The palette's per-tab toggle. Three answers, not two: a tab can be wrapped, be
// unwrapped, or have no opinion and follow the setting - which is what lets a
// second toggle hand the tab back to the default rather than only ever pinning
// it away from one.
describe("a tab's soft-wrap override", () => {
  // Everything but wrap is off, so each expectation below names only what the
  // override did.
  const wrapOff = only({ softWrap: false });
  const wrapOn = only({ softWrap: true });

  it("outranks the setting in both directions", () => {
    expect(activeEditorFeatures(wrapOff, { softWrap: true })).toEqual(["softWrap"]);
    expect(activeEditorFeatures(wrapOn, { softWrap: false })).toEqual([]);
  });

  it("falls back to the setting when the tab has no opinion", () => {
    for (const none of [null, undefined]) {
      expect(activeEditorFeatures(wrapOff, { softWrap: none }), `${none}`).toEqual([]);
      expect(activeEditorFeatures(wrapOn, { softWrap: none }), `${none}`).toEqual(["softWrap"]);
    }
    // And with no overrides argument at all, which is how a buffer with no tab
    // state resolves.
    expect(activeEditorFeatures(wrapOn)).toEqual(["softWrap"]);
  });

  it("leaves the other features alone", () => {
    // From the all-off block like the rest of this describe, so the expectation
    // below names the features this case is about and no others.
    const rest = only({
      indentGuides: true,
      softWrap: false,
      renderWhitespace: true,
      scrollPastEnd: true,
    });
    expect(activeEditorFeatures(rest, { softWrap: true })).toEqual([
      "indentGuides",
      "softWrap",
      "renderWhitespace",
      "scrollPastEnd",
    ]);
  });
});

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
