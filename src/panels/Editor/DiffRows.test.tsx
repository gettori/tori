import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import DiffRows from "./DiffRows";
import { buildRows } from "../../utils/diffView";

// Token colours come from a lazily imported engine; here it is a stub that
// classes every word, so the tests below can see colour and change mark meet.
vi.mock("./syntaxLines", () => ({
  languageForPath: async () => ({ name: "ts" }),
  tokenLines: (text: string) =>
    text.split("\n").map((line) =>
      line
        .split(/(\s+)/)
        .filter(Boolean)
        .map((t) => ({ text: t, cls: /^\w+$/.test(t) ? "sy-word" : null })),
    ),
}));

// The point of this component existing at all: two surfaces render a hunk, and
// they must render it the *same* way. Copying the markup into each would leave
// nothing to stop them drifting, so the markup lives here and these tests pin
// the behaviour both surfaces inherit.

const HUNK = ["-const timeout = 100", "+const timeout = 250", " unchanged line"];

describe("DiffRows", () => {
  it("highlights only the tokens that changed inside a paired line", () => {
    const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={false} />);
    const changed = [...container.querySelectorAll("span")].map((s) => s.textContent);
    // The differing token is wrapped; the shared prefix is not.
    expect(changed).toContain("100");
    expect(changed).toContain("250");
    expect(changed).not.toContain("const");
    expect(changed).not.toContain("timeout");
  });

  it("renders one row per line inline, and one paired row per line side-by-side", () => {
    const inline = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={false} />);
    const side = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={true} />);

    // Inline stacks del, add, context as siblings.
    expect(inline.container.children.length).toBe(3);
    // Side-by-side pairs the del with the add, so the same three lines become
    // two rows inside the single shared scroll container.
    const grid = side.container.firstElementChild!;
    expect(grid.children.length).toBe(2);
    // Every side row has exactly two cells, so the columns cannot misalign.
    for (const row of grid.children) expect(row.children.length).toBe(2);
  });

  it("offers a changed line to a caller that stages lines, and a context line to nobody", () => {
    const picked: number[] = [];
    const { container } = render(() => (
      <DiffRows rows={buildRows(HUNK)} twoColumn={false} selection={{ has: () => false, toggle: (i) => picked.push(i) }} />
    ));
    const lines = [...container.children] as HTMLElement[];
    // The body indices, which is what the backend selects by: 0 is the removal,
    // 1 the addition, 2 the unchanged line.
    lines.forEach((l) => fireEvent.click(l));
    expect(picked).toEqual([0, 1]);
  });

  it("does not make a diff clickable when the caller offers no selection", () => {
    const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={false} />);
    // A diff rendered purely for reading stays text, not a form: no role and
    // no tab stop on any of the thousands of lines a commit diff can have.
    for (const line of container.children) expect((line as HTMLElement).className).not.toMatch(/selectable/);
    expect(container.querySelectorAll('[role="checkbox"], [tabindex]')).toHaveLength(0);
  });

  it("lets the keyboard reach a line, and says whether it is picked", () => {
    const picked: number[] = [];
    const { container } = render(() => (
      <DiffRows
        rows={buildRows(HUNK)}
        twoColumn={false}
        selection={{ has: (i) => i === 0, toggle: (i) => picked.push(i) }}
      />
    ));
    const boxes = [...container.querySelectorAll('[role="checkbox"]')];
    // Only the two changed lines, each a tab stop reporting its own state.
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(boxes.map((b) => b.getAttribute("tabindex"))).toEqual(["0", "0"]);

    fireEvent.keyDown(boxes[1], { key: "Enter" });
    fireEvent.keyDown(boxes[1], { key: " " });
    fireEvent.keyDown(boxes[1], { key: "a" });
    expect(picked).toEqual([1, 1]);
  });

  it("picks by body index in both layouts, so a column choice cannot restage", () => {
    const seen: number[][] = [];
    for (const twoColumn of [false, true]) {
      const picked: number[] = [];
      const { container } = render(() => (
        <DiffRows
          rows={buildRows(HUNK)}
          twoColumn={twoColumn}
          selection={{ has: () => false, toggle: (i) => picked.push(i) }}
        />
      ));
      for (const el of container.querySelectorAll("div")) fireEvent.click(el);
      seen.push(picked.sort((a, b) => a - b));
    }
    // Side-by-side pairs the del with the add on one row; the indices it hands
    // back are still the two body lines, not the row it drew them on.
    expect(seen[1]).toEqual(seen[0]);
  });

  it("marks the lines the caller says are picked", () => {
    const { container } = render(() => (
      <DiffRows rows={buildRows(HUNK)} twoColumn={false} selection={{ has: (i) => i === 1, toggle: () => {} }} />
    ));
    const marked = [...container.children].filter((l) => (l as HTMLElement).className.match(/selected/));
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe("+const timeout = 250");
  });

  it("renders the same word-level highlights in both layouts", () => {
    const textOf = (twoColumn: boolean) => {
      const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={twoColumn} />);
      return [...container.querySelectorAll("span")].map((s) => s.textContent).sort();
    };
    // The layout changes; which tokens are marked as changed does not.
    expect(textOf(true)).toEqual(textOf(false));
  });

  it("keeps a changed token coloured and marked, in both layouts", async () => {
    for (const twoColumn of [false, true]) {
      const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={twoColumn} path="/repo/a.ts" />);
      await vi.waitFor(() => expect(container.querySelector(".sy-word")).not.toBeNull());
      const changed = [...container.querySelectorAll("span")].filter((s) => s.textContent === "250");
      expect(changed).toHaveLength(1);
      expect(changed[0].className).toMatch(/sy-word/);
      expect(changed[0].className).toMatch(/wordChanged/);
      // The shared prefix is coloured and not marked.
      const shared = [...container.querySelectorAll("span")].find((s) => s.textContent === "timeout")!;
      expect(shared.className).toMatch(/sy-word/);
      expect(shared.className).not.toMatch(/wordChanged/);
    }
  });
});
