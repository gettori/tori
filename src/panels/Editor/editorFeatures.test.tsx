// What the comfort extensions actually put on screen, in a real EditorView.
//
// The prefs unit test asserts which features are *chosen*; this one asserts the
// chosen ones render, because "the setting is on" and "there are guides in the
// buffer" are separate claims and only the second is the ticket. jsdom has no
// layout, but CodeMirror still builds its DOM, which is where both of these
// features live: a class on the line for the guides, a widget for the swatches.
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { editorPrefExtensions } from "./editorPrefs";
import { langForPath } from "./languages";
import type { EditorPrefs } from "../Settings/settingsStore";

const BASE: EditorPrefs = {
  indentGuides: false,
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: false,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  wordCompletion: true,
  hotExit: true,
};

const INDENTED = "function a() {\n    if (x) {\n        deep();\n    }\n}";
/** Somewhere inside the innermost block, so there is an active block to mark. */
const INSIDE_DEEP = INDENTED.indexOf("deep()");

let view: EditorView | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

function mount(doc: string, extensions: Extension, selection?: number): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions,
      selection: selection === undefined ? undefined : { anchor: selection },
    }),
  });
  return host;
}

describe("indentation guides", () => {
  it("marks the indented lines when the preference is on", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: true }));
    expect(el.querySelectorAll(".cm-indent-markers").length).toBeGreaterThan(0);
  });

  it("draws nothing at all when it is off", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: false }));
    expect(el.querySelectorAll(".cm-indent-markers")).toHaveLength(0);
  });

  it("gives the block the cursor is in its own colour", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: true }), INSIDE_DEEP);
    const styles = [...el.querySelectorAll(".cm-indent-markers")].map((n) => n.getAttribute("style") ?? "");
    // The package paints the guides as one gradient per level, each reading a
    // custom property. The active block's level reads a different one, which is
    // the whole of "the active guide is distinct" at the DOM level.
    expect(styles.some((s) => s.includes("--indent-marker-active-bg-color"))).toBe(true);
    expect(styles.some((s) => s.includes("--indent-marker-bg-color"))).toBe(true);
  });

  // No test here that the colours are `var(--border-*)` rather than literals:
  // `check-tokens.mjs` fails the build on a colour literal in `editorPrefs.ts`,
  // and asserting it again against the globally-injected stylesheet would only
  // restate that guard more weakly.
});

describe("css colour swatches", () => {
  it("puts a swatch beside a colour literal in a css buffer", async () => {
    const el = mount("a { color: #ff0000; }", await langForPath("/repo/a.css"));
    expect(el.querySelectorAll(".cm-css-color-picker-wrapper")).toHaveLength(1);
    expect(el.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#ff0000");
  });

  it("leaves the same literal alone in a buffer that is not css", async () => {
    // The picker reads the CSS syntax tree, so pairing it with the CSS pack is
    // what keeps it out of every other language rather than a check at runtime.
    const el = mount('const red = "#ff0000";', await langForPath("/repo/a.ts"));
    expect(el.querySelectorAll(".cm-css-color-picker-wrapper")).toHaveLength(0);
    expect(el.querySelectorAll('input[type="color"]')).toHaveLength(0);
  });

  it("finds every literal in the buffer, not just the first", async () => {
    const el = mount("a { color: #ff0000; background: #00ff00; }", await langForPath("/repo/a.css"));
    expect(el.querySelectorAll('input[type="color"]')).toHaveLength(2);
  });
});
