import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { UNCOMMITTED, type Blame } from "../../utils/blame";
import { parseDiffHunks } from "../../utils/diffHunks";
import { blameAtLine } from "./blameGutter";
import DiffBufferView from "./DiffBufferView";

const flags = vi.hoisted(() => ({ vim: false }));
vi.mock("../Settings/settingsStore", async (original) => ({
  ...(await original<typeof import("../Settings/settingsStore")>()),
  vimModeOn: () => flags.vim,
}));

const DOC = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");

// Line 3's value rewritten, and one line removed after line 14.
const DIFF = [
  "@@ -1,6 +1,6 @@",
  " const v1 = 1;",
  " const v2 = 2;",
  "-const v3 = 30;",
  "+const v3 = 3;",
  " const v4 = 4;",
  " const v5 = 5;",
  " const v6 = 6;",
  "@@ -12,7 +12,6 @@",
  " const v12 = 12;",
  " const v13 = 13;",
  " const v14 = 14;",
  "-const gone = 0;",
  " const v15 = 15;",
  " const v16 = 16;",
  " const v17 = 17;",
].join("\n");

const COMMITS = [
  { sha: "a".repeat(40), short: "aaaaaaa", author: "Ada", time: 1_600_000_000, summary: "first" },
  { sha: "b".repeat(40), short: "bbbbbbb", author: "Bo", time: 1_700_000_000, summary: "second" },
  { sha: UNCOMMITTED, short: "0000000", author: "Not Committed Yet", time: 1_800_000_000, summary: "" },
];

const BLAME: Blame = {
  head: "c".repeat(40),
  commits: COMMITS,
  lines: Array.from({ length: 20 }, (_, i) => (i === 2 ? 2 : i % 2)),
};

function mount(blame: Blame | null = null) {
  const { container } = render(() => (
    <DiffBufferView
      text={DOC}
      hunks={parseDiffHunks(DIFF)}
      path="/repo/a.ts"
      staged={false}
      busy={false}
      canStage
      blame={blame}
      onHunk={() => {}}
      onSelect={() => {}}
    />
  ));
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { container, view };
}

afterEach(() => {
  cleanup();
  flags.vim = false;
});

describe("DiffBufferView", () => {
  it("shows the file with both number columns and the removed lines above where they went", async () => {
    const { container } = mount();
    const gutters = [...container.querySelectorAll(".cm-gutter")].map((g) => g.className);
    const old = gutters.findIndex((c) => c.includes("cm-diff-old-numbers"));
    expect(old).toBeGreaterThanOrEqual(0);
    expect(gutters.findIndex((c) => c.includes("cm-lineNumbers"))).toBeGreaterThan(old);

    const removed = [...container.querySelectorAll(".cm-diff-removed")];
    expect(removed.map((w) => w.textContent)).toEqual(["const v3 = 30;", "const gone = 0;"]);
    expect(removed[0].nextElementSibling?.textContent).toBe("const v3 = 3;");
    expect(removed[1].nextElementSibling?.textContent).toBe("const v15 = 15;");

    // Both the document and the removed lines take the file's own colours.
    await vi.waitFor(() => expect(container.querySelector(".cm-diff-removed .sy-keyword")).not.toBeNull());
    expect(container.querySelector(".cm-line span[class]")).not.toBeNull();
  });

  it("moves the caret, opens find and matches, read-only as it is", () => {
    const { container, view } = mount();
    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "ArrowRight" }), "editor")).toBe(true);
    expect(view.state.selection.main.head).toBe(1);

    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "editor")).toBe(true);
    expect(container.querySelector(".cm-search")).not.toBeNull();
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "v3" })) });
    expect(container.querySelectorAll(".cm-searchMatch").length).toBeGreaterThan(0);

    expect(view.state.readOnly).toBe(true);
  });

  it("folds the unchanged stretches into bands that open on a click", () => {
    const { container } = mount();
    const bands = () => [...container.querySelectorAll<HTMLElement>(".cm-diff-hidden")];
    const content = () => container.querySelector(".cm-content")!.textContent;
    expect(bands().map((b) => b.textContent)).toEqual(["\u22ef 5 unchanged lines", "\u22ef 3 unchanged lines"]);
    expect(content()).not.toContain("const v9 = 9;");

    bands()[0].click();
    expect(bands()).toHaveLength(1);
    expect(content()).toContain("const v9 = 9;");
  });

  it("carries the same blame the editor tab lays on the same lines", () => {
    const { container, view } = mount(BLAME);
    expect(container.querySelector(".cm-blame-gutter")).not.toBeNull();
    const lines = Array.from({ length: 20 }, (_, i) => i + 1);
    const expected = lines.map((n) => {
      const commit = COMMITS[BLAME.lines[n - 1]];
      return commit.sha === UNCOMMITTED ? null : commit;
    });
    expect(lines.map((n) => blameAtLine(view.state, n))).toEqual(expected);
  });

  it("marks both strips of the overview ruler in document order, with no minimap", () => {
    const { container } = mount();
    const tops = (side: string) =>
      [...container.querySelectorAll<HTMLElement>(`.cm-diff-overview-${side} .cm-diff-overview-mark`)].map((m) =>
        parseFloat(m.style.top),
      );
    const old = tops("old");
    expect(old).toHaveLength(2);
    expect(tops("new")).toHaveLength(1);
    expect(old[0]).toBeLessThan(old[1]);
    expect(old[1]).toBeGreaterThan(50);
    expect(container.querySelector(".cm-sway-minimap")).toBeNull();
  });

  it("carries the vim layer when vim is on", () => {
    flags.vim = true;
    const { container } = mount();
    expect(container.querySelector(".cm-vim-panel")).not.toBeNull();
  });
});
