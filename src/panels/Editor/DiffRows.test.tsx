import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import DiffRows from "./DiffRows";
import { buildRows } from "../../utils/diffView";

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

  it("renders the same word-level highlights in both layouts", () => {
    const textOf = (twoColumn: boolean) => {
      const { container } = render(() => <DiffRows rows={buildRows(HUNK)} twoColumn={twoColumn} />);
      return [...container.querySelectorAll("span")].map((s) => s.textContent).sort();
    };
    // The layout changes; which tokens are marked as changed does not.
    expect(textOf(true)).toEqual(textOf(false));
  });
});
