import { describe, it, expect, afterEach } from "vitest";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { CURSOR_LAYER, vimExtension } from "./vimMode";

// A `.tsx` with no JSX in it: the extension is what puts a file in the jsdom
// project, and every claim here needs a real `EditorView` with real keydown
// events going into it.
//
// The risk this file exists for is not "does vim work" - that is the package's
// problem. It is that `@replit/codemirror-vim` intercepts keys through a DOM
// handler and calls `stopPropagation()` on anything it claims, so a key vim
// takes is dead in CodeMirror's other keymaps *and* in Sway's window-level
// hotkey dispatcher. Every binding this app has had to reach the editor before
// now has to survive that.

const held: EditorView[] = [];

/** An editor arranged the way `CodeEditor` arranges one: vim in a compartment
 *  ahead of Sway's own keymap, which is itself ahead of `defaultKeymap`. */
function mount(opts: { vim: boolean; doc?: string }) {
  const conf = new Compartment();
  const fired: string[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc: opts.doc ?? "alpha\nbeta\ngamma\n",
      extensions: [
        conf.of(vimExtension(opts.vim)),
        keymap.of([
          // Spelled `Cmd-` rather than `Mod-`, which is what `CodeEditor` uses.
          // `Mod` resolves per platform, and CodeMirror decides that from the
          // user agent, which under jsdom is not a Mac - so a `Mod-s` binding
          // here would quietly be testing Ctrl-S. The claim being made is that
          // vim does not take a metaKey combo, so the modifier is named.
          { key: "Cmd-s", preventDefault: true, run: () => (fired.push("save"), true) },
          { key: "Cmd-Shift-m", preventDefault: true, run: () => (fired.push("mention"), true) },
          { key: "F2", preventDefault: true, run: () => (fired.push("rename"), true) },
          { key: "F12", preventDefault: true, run: () => (fired.push("definition"), true) },
          { key: "Shift-F12", preventDefault: true, run: () => (fired.push("references"), true) },
          { key: "Shift-Alt-f", preventDefault: true, run: () => (fired.push("format"), true) },
        ]),
        keymap.of(defaultKeymap),
      ],
    }),
    parent: document.body,
  });
  held.push(view);
  return { view, conf, fired };
}

/** What reached `window`, i.e. what Sway's own hotkey dispatcher would see.
 *  A key vim claims never gets here, which is the whole reason to check. */
function watchWindow(): string[] {
  const seen: string[] = [];
  const listener = (e: Event) => seen.push((e as KeyboardEvent).key);
  window.addEventListener("keydown", listener);
  cleanups.push(() => window.removeEventListener("keydown", listener));
  return seen;
}

const cleanups: (() => void)[] = [];

/** Press `x` at the start of an editor built from `extensions`, and report the
 *  document afterwards. Two orderings of the same pair is the whole test. */
function withOrder(extensions: Extension[]): string {
  const view = new EditorView({
    state: EditorState.create({ doc: "alpha\n", extensions }),
    parent: document.body,
  });
  held.push(view);
  view.dispatch({ selection: { anchor: 0 } });
  press(view, "x");
  return view.state.doc.toString();
}

function press(view: EditorView, key: string, mods: Partial<KeyboardEventInit> = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  for (const v of held.splice(0)) v.destroy();
});

describe("with vim on", () => {
  // Horizontal motions and `x` throughout, never `j`/`k`: vertical movement
  // goes through `coordsAtPos`, and jsdom has no `getClientRects`, so a vim
  // `j` throws inside the package rather than moving anything. Nothing about
  // the claims here needs a line above or below.
  it("moves the caret on the motion keys instead of typing them", () => {
    const { view } = mount({ vim: true });
    view.dispatch({ selection: { anchor: 0 } });
    press(view, "l");
    expect(view.state.selection.main.head).toBe(1);
    press(view, "l");
    expect(view.state.selection.main.head).toBe(2);
    press(view, "h");
    expect(view.state.selection.main.head).toBe(1);
    // The other half of the claim: none of that arrived as text.
    expect(view.state.doc.toString()).toBe("alpha\nbeta\ngamma\n");
  });

  it("runs an operator", () => {
    const { view } = mount({ vim: true });
    view.dispatch({ selection: { anchor: 0 } });
    press(view, "x");
    expect(view.state.doc.toString()).toBe("lpha\nbeta\ngamma\n");
  });

  it("leaves Sway's own shortcuts alone", () => {
    // `vimKeyFromEvent` turns Cmd into `M-`, and vim binds nothing with it, so
    // these are never claimed and never stopped. If that ever changed, ⌘S would
    // stop saving with no error anywhere.
    const { view, fired } = mount({ vim: true });
    press(view, "s", { metaKey: true });
    press(view, "m", { metaKey: true, shiftKey: true });
    expect(fired).toEqual(["save", "mention"]);
  });

  it("leaves the language commands' function keys alone", () => {
    // Rename, go-to-definition, find-references and format, on the bindings the
    // library and Sway's F2 override put in the editor's own keymaps.
    const { view, fired } = mount({ vim: true });
    press(view, "F2");
    press(view, "F12");
    press(view, "F12", { shiftKey: true });
    // `keyCode` matters for this one alone. A shifted character binding is
    // matched through CodeMirror's fallback, which re-derives the unshifted
    // name from `event.keyCode` (70 is `f`); a synthetic event leaves that 0,
    // and `Shift-Alt-f` then never matches for a reason that has nothing to do
    // with vim.
    press(view, "F", { altKey: true, shiftKey: true, keyCode: 70 });
    expect(fired).toEqual(["rename", "definition", "references", "format"]);
  });

  it("lets the Cmd-Alt bindings through to the window dispatcher", () => {
    // The four LSP commands are registered in `commands.ts` at window scope, so
    // they are dispatched from a `window` keydown listener rather than by
    // CodeMirror. Vim calls `stopPropagation()` on anything it claims, which
    // would take them out without touching a line of their code.
    const { view } = mount({ vim: true });
    const seen = watchWindow();
    press(view, "d", { metaKey: true, altKey: true });
    press(view, "r", { metaKey: true, altKey: true });
    press(view, "n", { metaKey: true, altKey: true });
    press(view, "Tab", { ctrlKey: true });
    expect(seen).toEqual(["d", "r", "n", "Tab"]);
  });

  it("wins a contested key only because it comes first in the extensions", () => {
    // The placement rule, stated as a fact rather than as a comment. For a key
    // vim and a keymap both claim, whichever is earlier in the extension array
    // takes it - vim's handler and a keymap's are both `ViewPlugin`
    // `domEventHandlers`, ordered by extension precedence.
    //
    // It matters because `defaultKeymap`'s Mac bindings (Ctrl-A, Ctrl-E,
    // Ctrl-D, Ctrl-K) collide with vim's Ctrl commands, and in normal mode vim
    // is the one that should win. `CodeEditor` puts the compartment at the top
    // of `commonExtensions` for this reason.
    const contested = keymap.of([
      { key: "x", preventDefault: true, run: () => true },
    ]);
    const first = withOrder([vimExtension(true), contested]);
    const last = withOrder([contested, vimExtension(true)]);
    expect(first).toBe("lpha\n"); // vim's `x` deleted a character
    expect(last).toBe("alpha\n"); // the keymap swallowed it instead
  });

  it("does claim the plain keys, which is why the check above matters", () => {
    // The negative that gives the positives their meaning: `j` really is
    // stopped, so the window never sees it. A test asserting only that ⌘S
    // survives would pass just as well if vim were not installed at all.
    const { view } = mount({ vim: true });
    view.dispatch({ selection: { anchor: 0 } });
    const seen = watchWindow();
    press(view, "x");
    expect(seen).toEqual([]);
  });
});

describe("the block cursor's layer", () => {
  it("carries the class the theme's selectors are written against", () => {
    // The loop this closes: `vimTheme` builds its rules from `CURSOR_LAYER`,
    // and this asserts the package's own element carries exactly that class. A
    // rename on either side now fails here. Without it, a wrong selector fails
    // silently - the rule matches nothing, the package's hardcoded `#ff9696`
    // stays on screen, and the token guard is satisfied either way, because the
    // var names in a rule that matches nothing still resolve.
    const { view } = mount({ vim: true });
    const layer = view.dom.querySelector(`.${CURSOR_LAYER}`);
    expect(layer).toBeTruthy();
  });

  it("is a sibling of the content, not inside it", () => {
    // Which is why the selectors cannot be written against `.cm-content`:
    // `BlockCursorPlugin` appends its layer to `scrollDOM`.
    const { view } = mount({ vim: true });
    const layer = view.dom.querySelector(`.${CURSOR_LAYER}`)!;
    expect(view.contentDOM.contains(layer)).toBe(false);
    expect(view.scrollDOM.contains(layer)).toBe(true);
  });

  it("is gone when vim is off", () => {
    const { view } = mount({ vim: false });
    expect(view.dom.querySelector(`.${CURSOR_LAYER}`)).toBeNull();
  });
});

describe("with vim off", () => {
  it("does not move the caret on j", () => {
    const { view } = mount({ vim: false });
    view.dispatch({ selection: { anchor: 0 } });
    press(view, "l");
    expect(view.state.selection.main.head).toBe(0);
  });

  it("leaves plain keys to reach the window dispatcher", () => {
    const { view } = mount({ vim: false });
    const seen = watchWindow();
    press(view, "x");
    expect(seen).toEqual(["x"]);
  });

  it("still has Sway's shortcuts", () => {
    const { view, fired } = mount({ vim: false });
    press(view, "s", { metaKey: true });
    expect(fired).toEqual(["save"]);
  });
});

describe("toggling the compartment", () => {
  it("enters vim in a live buffer without touching its content", () => {
    const { view, conf } = mount({ vim: false, doc: "alpha\nbeta\n" });
    view.dispatch({ selection: { anchor: 3 } });
    view.dispatch({ effects: conf.reconfigure(vimExtension(true)) });
    expect(view.state.doc.toString()).toBe("alpha\nbeta\n");
    expect(view.state.selection.main.head).toBe(3);
    press(view, "l");
    expect(view.state.selection.main.head).not.toBe(3);
  });

  it("leaves vim the same way", () => {
    const { view, conf } = mount({ vim: true, doc: "alpha\nbeta\n" });
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ effects: conf.reconfigure(vimExtension(false)) });
    press(view, "l");
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe("alpha\nbeta\n");
  });

  it("can be reconfigured in a state that is in no view at all", () => {
    // What a background tab is. Only the shown buffer is in the view; every
    // other one is a stashed `EditorState`, and the only handle on it is
    // `state.update`. Without this the setting would apply to the file on
    // screen and to nothing else.
    const conf = new Compartment();
    const state = EditorState.create({
      doc: "alpha\n",
      extensions: [conf.of(vimExtension(false))],
    });
    const next = state.update({ effects: conf.reconfigure(vimExtension(true)) }).state;
    expect(next.doc.toString()).toBe("alpha\n");
    expect(next).not.toBe(state);
  });
});
