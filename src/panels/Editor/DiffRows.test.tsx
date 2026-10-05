import { describe, it, expect, vi } from "vite-plus/test";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import DiffRows, { rovingHunk } from "./DiffRows";
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
      <DiffRows
        rows={buildRows(HUNK)}
        twoColumn={false}
        selection={{ has: () => false, toggle: (i) => picked.push(i) }}
      />
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

  it("numbers each line on both sides inline, and on its own side side-by-side", () => {
    const rows = buildRows(HUNK, { old: 7, new: 9 });
    const nums = (el: Element) => [el.getAttribute("data-old"), el.getAttribute("data-new")];
    const picked: number[] = [];
    const inline = render(() => (
      <DiffRows rows={rows} twoColumn={false} selection={{ has: () => false, toggle: (i) => picked.push(i) }} />
    ));
    const lines = [...inline.container.children];
    expect(lines.map(nums)).toEqual([
      ["7", null],
      [null, "9"],
      ["8", "10"],
    ]);
    // Generated content, not text: a line still reads as exactly its diff line.
    expect(lines.map((l) => l.textContent)).toEqual(HUNK);
    lines.forEach((l) => fireEvent.click(l));
    expect(picked).toEqual([0, 1]);

    const side = render(() => <DiffRows rows={rows} twoColumn={true} />);
    const grid = side.container.firstElementChild!;
    expect([...grid.children].map((row) => [...row.children].map(nums))).toEqual([
      [
        ["7", null],
        [null, "9"],
      ],
      [
        ["8", null],
        [null, "10"],
      ],
    ]);
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
  it("gives a roving hunk one tab stop, however many rows it has", () => {
    // The number that matters. Staging makes every changed line a tab stop,
    // which is right for a hunk you are picking through and wrong for a pull
    // request: at 2,000 rows, tabbing is the only way out of the diff, and
    // there is no way out.
    const hunk = Array.from({ length: 100 }, (_, i) => `+line ${i}`);
    const { container } = render(() => (
      <>
        {Array.from({ length: 20 }, () => (
          <DiffRows rows={buildRows(hunk)} twoColumn={false} keyboard="roving" />
        ))}
      </>
    ));
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(20 * 100);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(20);
  });

  it("moves the roving stop with the arrow keys and leaves the rest alone", () => {
    const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={false} keyboard="roving" />);
    const rows = [...container.children] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(document.activeElement).toBe(rows[1]);

    // The ends hold rather than wrapping: a diff is a document, and arriving
    // back at line 1 from the bottom reads as having lost your place.
    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    fireEvent.keyDown(rows[0], { key: "ArrowUp" });
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("offers a comment affordance per row without spending a tab stop on it", () => {
    const asked: [number, boolean][] = [];
    const { container } = render(() => (
      <DiffRows
        rows={buildRows(HUNK)}
        twoColumn={false}
        keyboard="roving"
        comment={{ onComment: (i, extend) => asked.push([i, extend]), label: (i) => `Add a comment on line ${i}` }}
      />
    ));
    const adds = [...container.querySelectorAll("button")] as HTMLButtonElement[];
    expect(adds).toHaveLength(3);
    expect(adds.every((b) => b.tabIndex === -1)).toBe(true);
    expect(adds[0].getAttribute("aria-label")).toBe("Add a comment on line 0");

    fireEvent.click(adds[1]);
    fireEvent.click(adds[2], { shiftKey: true });
    expect(asked).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("hands a key to the surface before acting on it itself", () => {
    const seen: string[] = [];
    const { container } = render(() => (
      <DiffRows
        rows={buildRows(HUNK)}
        twoColumn={false}
        keyboard="roving"
        onRowKey={(i, e) => {
          seen.push(`${i}:${e.key}`);
          return e.key === "c";
        }}
      />
    ));
    const rows = [...container.children] as HTMLElement[];
    fireEvent.keyDown(rows[0], { key: "c" });
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(seen).toEqual(["0:c", "0:ArrowDown"]);
    // It took `c` and declined the arrow, so only the arrow moved the stop.
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });
  it("keeps one stop across the pieces a thread cuts a hunk into", () => {
    // A thread anchored mid-hunk splits the rows in two, and the pieces are
    // still one hunk to a reader. A stop each would mean tabbing through a file
    // costs one stop per conversation in it.
    const hunk = rovingHunk();
    const rows = buildRows(["+one", "+two", "+three", "+four"]);
    const { container } = render(() => (
      <>
        <DiffRows rows={rows.slice(0, 2)} twoColumn={false} keyboard="roving" roving={hunk} offset={0} />
        <div>a thread card</div>
        <DiffRows rows={rows.slice(2)} twoColumn={false} keyboard="roving" roving={hunk} offset={2} />
      </>
    ));
    const stops = () => [...container.querySelectorAll('[tabindex="0"]')];
    expect(stops()).toHaveLength(1);

    // And the arrows cross the cut, or the rows past it are reachable by
    // nothing at all.
    const cells = [...container.querySelectorAll("[class*=diffLine]")] as HTMLElement[];
    fireEvent.keyDown(cells[1], { key: "ArrowDown" });
    expect(stops()).toHaveLength(1);
    expect(document.activeElement).toBe(cells[2]);
  });

  it("keeps a stop on the hunk when its rows shrink underneath it", () => {
    // Rows change under a live instance: a gap collapses, a thread arrives and
    // re-cuts the hunk. An index left past the end puts every row at -1, and a
    // hunk with no stop at all is one the keyboard cannot enter.
    const hunk = rovingHunk();
    const [long, setLong] = createSignal(true);
    const { container } = render(() => (
      <DiffRows
        rows={buildRows(long() ? ["+a", "+b", "+c", "+d"] : ["+a", "+b"])}
        twoColumn={false}
        keyboard="roving"
        roving={hunk}
      />
    ));
    const cells = [...container.querySelectorAll("[class*=diffLine]")] as HTMLElement[];
    fireEvent.keyDown(cells[0], { key: "ArrowDown" });
    fireEvent.keyDown(cells[1], { key: "ArrowDown" });
    fireEvent.keyDown(cells[2], { key: "ArrowDown" });
    expect(hunk.at()).toBe(3);

    setLong(false);
    expect(container.querySelectorAll("[class*=diffLine]")).toHaveLength(2);
    // The stop came back into the rows that exist rather than pointing past
    // them. Reached by an arrow, which is what a reader has to hand.
    const left = [...container.querySelectorAll("[class*=diffLine]")] as HTMLElement[];
    fireEvent.keyDown(left[0], { key: "ArrowUp" });
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });
});
