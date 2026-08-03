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
        "lsp-definition",
        "lsp-format",
        "lsp-references",
        "lsp-rename",
        "next-waiting",
        "project-search",
        "quick-open",
        "reload",
        "shortcut-sheet",
        "stop-chat",
        "tab-cycle",
        "tab-jump",
        "terminal-search",
        "toggle-editor",
        "toggle-filetree",
        "toggle-sidebar",
        "toggle-terminal",
        "zoom-in",
        "zoom-out",
        "zoom-reset",
      ].sort(),
    );
  });

  it("places every binding in a group the sheet renders", () => {
    const rendered = bindingsByGroup().flatMap((g) => g.bindings);
    expect(rendered).toHaveLength(BINDINGS.length);
    for (const b of BINDINGS) expect(GROUP_LABELS[b.group]).toBeTruthy();
  });

  it("lists the language-server commands in the sheet's Editor group", () => {
    // The four keys the LSP client binds privately (F12, ⇧F12, F2, ⇧⌥F) were
    // shortcuts nothing in the app could print, and three of them need Fn on a
    // Mac laptop. The Editor group used to drop out of the sheet entirely for
    // having no key-carrying command in it.
    const editor = bindingsByGroup().find((g) => g.group === "editor");
    expect(editor?.bindings.map((b) => b.id)).toEqual([
      "lsp-definition",
      "lsp-references",
      "lsp-rename",
      "lsp-format",
    ]);
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
    // Zoom: ⌘= and ⌘⇧+ both zoom in; ⌘- / ⌘_ zoom out; ⌘0 resets.
    expect(dispatchHotkey(key("=", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("+", { meta: true, shift: true }))).toBe(true);
    expect(dispatchHotkey(key("-", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("0", { meta: true }))).toBe(true);
    expect(dispatchHotkey(key("r", { meta: true }))).toBe(true);
  });

  it("matches Option chords on e.code, not the rewritten glyph", () => {
    // macOS rewrites e.key to the Option glyph while Option is held (Opt+J is
    // "∆"), so the view toggles must match e.code. A code-bearing event fires;
    // one carrying only the glyph must not.
    const withCode = (code: string, glyph: string) =>
      ({ key: glyph, code, metaKey: true, altKey: true, shiftKey: false, ctrlKey: false }) as KeyboardEvent;
    expect(dispatchHotkey(withCode("KeyJ", "∆"))).toBe(true);
    expect(dispatchHotkey(withCode("KeyE", "´"))).toBe(true);
    expect(dispatchHotkey(withCode("KeyB", "∫"))).toBe(true);
    // Cmd+B (no Option) toggles the sidebar and is unaffected.
    expect(dispatchHotkey(key("b", { meta: true }))).toBe(true);
    // Cmd+Opt+B (filetree) and Cmd+B (sidebar) do not collide.
    expect(dispatchHotkey(key("b", { meta: true, alt: true }))).toBe(false);
  });

  it("does NOT steal Cmd+P from a focused terminal", () => {
    // The whole reason `window` scope exists: quick-open must not swallow the
    // key from a program running in the terminal.
    expect(dispatchHotkey(key("p", { meta: true }))).toBe(false);
    expect(dispatchWindowHotkey(key("p", { meta: true }))).toBe(true);
  });

  it("does not claim Cmd+S, which the focused editor owns", () => {
    // "Save file" is a palette command with no key: CodeMirror's own Mod-s is
    // the only save key. A table-level binding would fire while a terminal had
    // focus and save a file nobody was looking at.
    expect(dispatchHotkey(key("s", { meta: true }))).toBe(false);
    expect(dispatchWindowHotkey(key("s", { meta: true }))).toBe(false);
  });

  it("does not fire an LSP command at an editor nobody is looking at", () => {
    // `window` scope, not `global`: these act on the shown buffer, so firing
    // one while a terminal has focus would rename a symbol in a file the user
    // is not looking at. xterm swallows the keydown before it reaches window,
    // which is exactly what the two dispatchers differ on.
    const cmdOpt = (code: string) =>
      ({ key: "", code, metaKey: true, altKey: true, shiftKey: false, ctrlKey: false }) as KeyboardEvent;
    expect(dispatchHotkey(cmdOpt("KeyD"))).toBe(false);
    expect(dispatchWindowHotkey(cmdOpt("KeyD"))).toBe(true);
    expect(dispatchWindowHotkey(cmdOpt("KeyR"))).toBe(true);
    expect(dispatchWindowHotkey(cmdOpt("KeyN"))).toBe(true);
    const shiftOptF = {
      key: "Ï",
      code: "KeyF",
      metaKey: false,
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
    } as KeyboardEvent;
    expect(dispatchWindowHotkey(shiftOptF)).toBe(true);
    expect(dispatched.map((e) => e.type)).toEqual([
      "sway:editor-lsp-definition",
      "sway:editor-lsp-references",
      "sway:editor-lsp-rename",
      "sway:editor-lsp-format",
    ]);
  });

  it("does not claim Cmd+F, which the focused terminal owns", () => {
    expect(dispatchHotkey(key("f", { meta: true }))).toBe(false);
    expect(dispatchWindowHotkey(key("f", { meta: true }))).toBe(false);
  });

  it("yields to a key the focused widget already handled", () => {
    // CodeMirror preventDefaults every binding it runs and the window listener
    // sits on the bubble phase, so a handled Cmd+/ still reaches dispatch.
    // Without the guard it would toggle a comment AND open the shortcut sheet.
    const handled = { ...key("/", { meta: true }), defaultPrevented: true } as KeyboardEvent;
    expect(dispatchHotkey(handled)).toBe(false);
    expect(dispatchWindowHotkey(handled)).toBe(false);
    expect(dispatchHotkey(key("/", { meta: true }))).toBe(true);
  });

  it("ignores unmodified and wrongly-modified keys", () => {
    expect(dispatchHotkey(key("k"))).toBe(false);
    expect(dispatchHotkey(key("j", { meta: true, shift: true }))).toBe(false);
    expect(dispatchHotkey(key("Tab", { ctrl: true, shift: true }))).toBe(false);
    // ⌘0 resets zoom, but ⌘⇧0 is deliberately unbound.
    expect(dispatchHotkey(key("0", { meta: true, shift: true }))).toBe(false);
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
