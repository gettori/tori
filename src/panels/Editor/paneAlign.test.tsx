import { describe, it, expect, afterEach } from "vite-plus/test";
import { waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";
import { lineAnchor, paneAligner, type AlignMember } from "./paneAlign";

// Plain editors rather than the conflict tab: nothing here scrolls, so jsdom
// never measures the DOM and the height map keeps its estimates, which is the
// only geometry these tests can see.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

describe("lining editors up", () => {
  it("holds a region at the same offset in every editor, and again after an edit", async () => {
    const lineOf = (view: EditorView, text: string) => view.state.doc.toString().split("\n").indexOf(text) + 1;
    // The region is line 2 up to the line holding "c", on every side.
    const member = (view: EditorView): AlignMember => ({
      view,
      anchors: [lineAnchor(view.state.doc, 2, "top"), lineAnchor(view.state.doc, lineOf(view, "c"), "text")],
    });
    const aligner = paneAligner(() => views.map((view) => [member(view)]));
    for (const doc of ["a\nO1\nO2\nO3\nc\nd\n", "a\nT1\nc\nd\n", "a\n\nc\nd\n"]) {
      views.push(new EditorView({ doc, extensions: aligner.extension, parent: document.body }));
    }
    // A block's top is above any spacer sitting on it, so the region's end is
    // read off "d", the first line with nothing placed on top of it.
    const spread = (text: string) => {
      const tops = views.map((view) => view.lineBlockAt(view.state.doc.line(lineOf(view, text)).from).top);
      return Math.max(...tops) - Math.min(...tops);
    };

    aligner.schedule();
    await waitFor(() => expect(spread("d")).toBeLessThan(1.5));
    expect(spread("a")).toBeLessThan(1.5);

    const result = views[2];
    result.dispatch({ changes: { from: result.state.doc.line(2).from, insert: "W\nX\nY\nZ\n" } });

    // Taller than the other two now, so the space goes into them instead.
    await waitFor(() => expect(views[0].lineBlockAt(views[0].state.doc.line(6).from).top).toBeGreaterThan(70));
    expect(spread("d")).toBeLessThan(1.5);
    aligner.destroy();
  });
});
