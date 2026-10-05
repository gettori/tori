// preserveScrollAndFocus (plan phase 6). jsdom has no layout, so a row move
// does not reset scrollTop the way a browser does; the first two tests
// simulate the browser's resets inside `fn` and pin the restore half, and the
// last runs a real keyed <For> reorder over a mixed list, the shape the
// terminal stage actually is.
import { describe, it, expect } from "vite-plus/test";
import { createSignal, For } from "solid-js";
import { render } from "@solidjs/testing-library";
import { preserveScrollAndFocus } from "./rowMovePreserve";

describe("preserveScrollAndFocus", () => {
  it("puts focus back on an element a move dropped it from", () => {
    const { container } = render(() => (
      <div>
        <div class="row">
          <input data-testid="composer" />
        </div>
      </div>
    ));
    const input = container.querySelector("input")!;
    input.focus();
    expect(document.activeElement).toBe(input);
    preserveScrollAndFocus(container, () => {
      // A keyed row move is detach plus reattach; jsdom drops focus on the
      // detach exactly like a browser.
      const row = input.parentElement!;
      const parent = row.parentElement!;
      row.remove();
      parent.appendChild(row);
      expect(document.activeElement).not.toBe(input);
    });
    expect(document.activeElement).toBe(input);
  });

  it("puts scroll back on a container a move reset", () => {
    const { container } = render(() => (
      <div>
        <div class="scroller" />
      </div>
    ));
    const scroller = container.querySelector<HTMLElement>(".scroller")!;
    scroller.scrollTop = 1200;
    preserveScrollAndFocus(container, () => {
      // The browser's reset on detach, simulated: jsdom has no layout and
      // would otherwise keep the value through the move.
      scroller.scrollTop = 0;
    });
    expect(Math.abs(scroller.scrollTop - 1200)).toBeLessThanOrEqual(1);
  });

  it("carries a mixed keyed <For> reorder with a scrolled chat and a focused composer", () => {
    type Row = { id: string; kind: "chat" | "file" };
    const rows: Row[] = [
      { id: "c1", kind: "chat" },
      { id: "f1", kind: "file" },
      { id: "c2", kind: "chat" },
    ];
    const [items, setItems] = createSignal(rows);
    const { container } = render(() => (
      <div>
        <For each={items()}>
          {(r) => (
            <div data-id={r.id}>
              <div class="scroller" data-scroll-of={r.id} />
              <input data-composer-of={r.id} />
            </div>
          )}
        </For>
      </div>
    ));
    const scroller = container.querySelector<HTMLElement>('[data-scroll-of="c1"]')!;
    const composer = container.querySelector<HTMLElement>('[data-composer-of="c1"]')!;
    scroller.scrollTop = 640;
    composer.focus();

    preserveScrollAndFocus(container, () => setItems([rows[1], rows[2], rows[0]]));

    const order = Array.from(container.querySelectorAll("[data-id]")).map((el) =>
      el.getAttribute("data-id"),
    );
    expect(order).toEqual(["f1", "c2", "c1"]);
    expect(Math.abs(scroller.scrollTop - 640)).toBeLessThanOrEqual(1);
    expect(document.activeElement).toBe(composer);
  });
});
