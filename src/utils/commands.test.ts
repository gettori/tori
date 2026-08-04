import { describe, it, expect } from "vitest";
// Read as text rather than with `node:fs`: this project ships no `@types/node`,
// and `?raw` is how the other source-inspecting test (revertGuard) does it.
import commandsSource from "./commands.ts?raw";
import { COMMANDS } from "./commands";

describe("the canonical command table", () => {
  it("has a unique id per command", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every key-carrying command a matcher and a scope", () => {
    // `keys` is what promotes a command into BINDINGS, and the dispatcher reads
    // `scope` and `match` off it. One without the others is a command that the
    // Cmd+/ sheet advertises a key for and nothing ever fires.
    for (const c of COMMANDS.filter((c) => c.keys)) {
      expect(c.match, `${c.id} lists keys but has no matcher`).toBeTypeOf("function");
      expect(c.scope, `${c.id} lists keys but has no scope`).toBeTruthy();
    }
  });

  it("has no two bindings that the same keystroke can fire", () => {
    // `dispatchHotkey` takes the FIRST binding whose `match` returns true, so a
    // second command answering the same keystroke is not a conflict anybody
    // sees: it is simply dead, while the sheet goes on printing its key. Probed
    // with synthetic events rather than by comparing the `keys` chips, because
    // the chips are display text and the matcher is the thing that fires.
    const bindings = COMMANDS.filter((c) => c.match && c.scope);
    const codes = [
      ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
      ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`),
      "Slash",
      "Period",
      "Equal",
      "Minus",
      "Tab",
      "F12",
    ];
    const mods = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const code of codes) {
      // `e.key` matters as much as `e.code`: half the matchers read one, half
      // the other, so both are set the way a real keydown would.
      const key = code.startsWith("Key")
        ? code.slice(3).toLowerCase()
        : code.startsWith("Digit")
          ? code.slice(5)
          : { Slash: "/", Period: ".", Equal: "=", Minus: "-", Tab: "Tab", F12: "F12" }[code]!;
      for (const m of mods) {
        const e = {
          code,
          key,
          metaKey: !!(m & 1),
          shiftKey: !!(m & 2),
          altKey: !!(m & 4),
          ctrlKey: false,
        } as KeyboardEvent;
        const hits = bindings.filter((c) => c.match!(e)).map((c) => c.id);
        expect(hits.length, `${code} with mods ${m} fires ${hits.join(" and ")}`).toBeLessThan(2);
      }
    }
  });

  it("gives every runnable palette command a run", () => {
    for (const c of COMMANDS.filter((c) => !c.hidden)) {
      expect(c.run, `${c.id} is offered in the palette but does nothing`).toBeTypeOf("function");
    }
  });

  it("only omits `run` for a terminal-scoped command", () => {
    // The one legitimate case: the focused xterm owns the key, so there is no
    // table-level action. Anything else missing a `run` is an oversight.
    for (const c of COMMANDS.filter((c) => !c.run)) {
      expect(c.scope, `${c.id} has no run and is not terminal-scoped`).toBe("terminal");
    }
  });

  it("never gives an editor command the global scope", () => {
    // The property that matters, and the reason the editor group was keyless to
    // begin with: `global` is dispatched through `dispatchHotkey`, which the
    // terminal calls too, so a global editor binding acts on a file nobody is
    // looking at while a terminal has focus. `window` does not have that
    // problem, which is what lets the language-server commands carry a chord
    // the shortcut sheet can print - a binding the library installs privately
    // is one nothing can tell the user about.
    for (const c of COMMANDS.filter((c) => c.group === "editor")) {
      expect(c.scope, `${c.id} is global; an editor action must not fire at a terminal`).not.toBe(
        "global",
      );
    }
  });

  it("leaves the chord to CodeMirror for every command CodeMirror already binds", () => {
    // These four are `defaultKeymap`'s, so a table-level binding would be a
    // second one firing on the same press. They are listed for discoverability
    // and reached by name only.
    for (const id of [
      "editor-expand-selection",
      "editor-shrink-selection",
      "editor-join-lines",
      "editor-split-selection",
      "editor-save",
    ]) {
      const c = COMMANDS.find((c) => c.id === id);
      if (!c) continue; // named by id so a rename shows up as a miss, not a pass
      expect(c.keys, `${id} carries a key CodeMirror already owns`).toBeUndefined();
    }
  });

  it("lists every selection command as a visible, file-gated row", () => {
    // Their chords are CM6's own, so they appear in no key sheet: the palette
    // row is the only place they are named. A hidden one would be unreachable
    // by name and undiscoverable by key at the same time.
    for (const id of [
      "editor-expand-selection",
      "editor-shrink-selection",
      "editor-join-lines",
      "editor-split-selection",
    ]) {
      const c = COMMANDS.find((c) => c.id === id);
      expect(c, `${id} is missing from the table`).toBeTruthy();
      expect(c?.hidden, `${id} is hidden, and has no key to be found by instead`).toBeFalsy();
      expect(c?.requires, `${id} acts on a buffer, so it needs one`).toContain("editorFile");
    }
  });

  it("imports nothing outside utils/events", () => {
    // Load-bearing, not stylistic. `hotkeys.ts` derives BINDINGS from this table
    // and TerminalView imports `hotkeys.ts`, so an import added here lands in
    // the terminal's chunk. That is the whole reason every `run` emits an event
    // and `requires` is a tag rather than a store read.
    const imports = [...commandsSource.matchAll(/^import[\s\S]*?from\s+"([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./events"]);
  });
});
