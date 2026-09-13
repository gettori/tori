import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { conflictBands } from "./conflictBands";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DIFF3 = ["one", "<<<<<<< HEAD", "ours", "||||||| base", "base", "=======", "theirs", ">>>>>>> feature", "two"];

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

function mount(lines: string[]): EditorView {
  view = new EditorView({ doc: lines.join("\n"), extensions: conflictBands(), parent: document.body });
  return view;
}

const painted = (cls: string) => [...view!.contentDOM.querySelectorAll(`.cm-line.${cls}`)].map((el) => el.textContent);

describe("a conflicted file in the editor", () => {
  it("paints a diff3 conflict's three sections and its marker lines", () => {
    mount(DIFF3);

    expect(painted("cm-conflict-current")).toEqual(["ours"]);
    expect(painted("cm-conflict-base")).toEqual(["base"]);
    expect(painted("cm-conflict-incoming")).toEqual(["theirs"]);
    expect(painted("cm-conflict-marker")).toEqual(["<<<<<<< HEAD", "||||||| base", "=======", ">>>>>>> feature"]);
  });

  it("keeps the bands on their lines through an edit above, and drops them once the markers go", () => {
    const editor = mount(DIFF3);

    editor.dispatch({ changes: { from: 0, insert: "added\n" } });
    expect(painted("cm-conflict-current")).toEqual(["ours"]);

    const text = editor.state.doc.toString();
    editor.dispatch({ changes: { from: text.indexOf("<<<<<<<"), to: text.indexOf("two"), insert: "ours\n" } });

    expect(painted("cm-conflict-current")).toEqual([]);
    expect(painted("cm-conflict-marker")).toEqual([]);
    expect(editor.dom.classList.contains("cm-conflict-overview-host")).toBe(false);
  });

  it("marks a conflict below the fold on the overview strip", () => {
    const editor = mount([...Array.from({ length: 300 }, (_, i) => `line ${i}`), ...DIFF3]);

    const marks = editor.dom.querySelectorAll<HTMLElement>(".cm-conflict-overview-mark");
    expect(marks).toHaveLength(1);
    expect(parseFloat(marks[0].style.top)).toBeGreaterThan(90);
    expect(editor.dom.classList.contains("cm-conflict-overview-host")).toBe(true);
  });
});
