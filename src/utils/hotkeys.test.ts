import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BINDINGS, GROUP_LABELS, bindingsByGroup, dispatchHotkey, dispatchWindowHotkey } from "./hotkeys";

// `match` only reads flag properties, so a plain object is a faithful stand-in
// and keeps these tests independent of a DOM environment.
function key(k: string, mods: { meta?: boolean; shift?: boolean; ctrl?: boolean; alt?: boolean } = {}) {
  return {
    key: k,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
  } as KeyboardEvent;
}

// The suite runs in the node environment, so `window` is stubbed rather than
// spied on. Only `dispatchEvent` is needed: emit()/emitWith() go through it.
let dispatched: CustomEvent[];

beforeEach(() => {
  dispatched = [];
  vi.stubGlobal("window", {
    dispatchEvent: (e: CustomEvent) => {
      dispatched.push(e);
      return true;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the canonical binding table", () => {
  it("has a unique id per binding", () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the canonical binding list", () => {
    // The list Sway documents. If a binding is added or removed, this test and
    // the Cmd+/ sheet move together, because both read BINDINGS.
    expect(BINDINGS.map((b) => b.id).sort()).toEqual(
      [
        "command-palette",
        "filter-sidebar",
        "focus-terminal",
        "next-waiting",
        "project-search",
        "quick-open",
        "shortcut-sheet",
        "tab-cycle",
        "tab-jump",
        "terminal-search",
      ].sort(),
    );
  });

  it("places every binding in a group the sheet renders", () => {
    const rendered = bindingsByGroup().flatMap((g) => g.bindings);
    expect(rendered).toHaveLength(BINDINGS.length);
    for (const b of BINDINGS) expect(GROUP_LABELS[b.group]).toBeTruthy();
  });

  it("gives every binding key chips and a label", () => {
    for (const b of BINDINGS) {
      expect(b.keys.length, `${b.id} needs key chips`).toBeGreaterThan(0);
      expect(b.label.length, `${b.id} needs a label`).toBeGreaterThan(0);
    }
  });

  it("only omits an action for terminal-scoped bindings", () => {
    // A missing `run` anywhere else would be a binding the sheet advertises
    // but nothing handles.
    for (const b of BINDINGS) {
      if (b.scope === "terminal") expect(b.run, `${b.id}`).toBeUndefined();
      else expect(b.run, `${b.id} must be handled`).toBeTypeOf("function");
    }
  });
});

describe("dispatchHotkey (terminal-safe subset)", () => {
  it("handles the global bindings", () => {
    expect(dispatchHotkey(key("k", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("j", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("/", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("f", { meta: true, shift: true }))).toBe(true);
    expect(dispatchHotkey(key("a", { meta: true, shift: true }))).toBe(true);
    expect(dispatchHotkey(key("e", { meta: true, shift: true }))).toBe(true);
    expect(dispatchHotkey(key("Tab", { ctrl: true }))).toBe(true);
    expect(dispatchHotkey(key("3", { meta: true }))).toBe(true);
  });

  it("does NOT steal Cmd+P from a focused terminal", () => {
    // The whole reason `window` scope exists: quick-open must not swallow the
    // key from a program running in the terminal.
    expect(dispatchHotkey(key("p", { meta: true }))).toBe(false);
    expect(dispatchWindowHotkey(key("p", { meta: true }))).toBe(true);
  });

  it("does not claim Cmd+F, which the focused terminal owns", () => {
    expect(dispatchHotkey(key("f", { meta: true }))).toBe(false);
    expect(dispatchWindowHotkey(key("f", { meta: true }))).toBe(false);
  });

  it("ignores unmodified and wrongly-modified keys", () => {
    expect(dispatchHotkey(key("k"))).toBe(false);
    expect(dispatchHotkey(key("j", { meta: true, shift: true }))).toBe(false);
    expect(dispatchHotkey(key("Tab", { ctrl: true, shift: true }))).toBe(false);
    expect(dispatchHotkey(key("0", { meta: true }))).toBe(false);
  });

  it("carries the tab index on Cmd+1..9", () => {
    // Cmd+1 is tab 0: the label says 1-9, the payload is 0-indexed.
    dispatchHotkey(key("1", { meta: true }));
    dispatchHotkey(key("9", { meta: true }));
    expect(dispatched.map((e) => e.detail?.index)).toEqual([0, 8]);
  });

  it("emits the event each binding claims to", () => {
    dispatchWindowHotkey(key("p", { meta: true }));
    dispatchHotkey(key("k", { meta: true }));
    dispatchHotkey(key("/", { meta: true }));
    expect(dispatched.map((e) => e.type)).toEqual([
      "sway:open-quick-open",
      "sway:open-palette",
      "sway:toggle-shortcuts",
    ]);
  });
});
