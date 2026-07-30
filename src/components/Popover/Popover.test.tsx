import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import Popover, { type PopoverAnchor } from "./Popover";

// jsdom reports every rect as zero, so what a test can hold here is *which
// edge* the surface is pinned to and *when* it is painted, not its measured
// width. Both are what actually went wrong: the History panel used to paint
// left-aligned and then re-align right on the next frame, jumping its whole
// width across the screen.
const surface = () => screen.getByRole("dialog");
const placed = async () => await waitFor(() => expect(surface().style.opacity).toBe(""));

function open(over: Partial<Parameters<typeof Popover>[0]> = {}) {
  const onClose = vi.fn();
  const anchor: PopoverAnchor = { left: 100, right: 400, top: 50 };
  const r = render(() => (
    <Popover anchor={anchor} onClose={onClose} role="dialog" aria-label="Test" {...over}>
      <button>inside</button>
    </Popover>
  ));
  return { onClose, ...r };
}

describe("Popover", () => {
  it("paints nothing until it has been placed", async () => {
    open();
    // Before the measuring frame: laid out (so it can be measured) and in the
    // accessibility tree (so a screen reader does not lose it), but invisible.
    expect(surface().style.opacity).toBe("0");
    expect(surface().style.pointerEvents).toBe("none");

    await placed();
    expect(surface().style.pointerEvents).toBe("");
  });

  it.each([
    ["start", "100px"],
    ["end", "400px"],
  ] as const)("pins its %s edge to the anchor", async (align, left) => {
    open({ align });
    await placed();
    expect(surface().style.left).toBe(left);
  });

  it("clamps back in from the viewport edge rather than overflowing", async () => {
    open({ anchor: { left: 5000, right: 5000, top: 50 } });
    await placed();
    // 1024 (jsdom's window) less the 6px gutter, since the rect measures zero.
    expect(surface().style.left).toBe("1018px");
  });

  it("closes on Escape and on an outside click, but not on the anchor's own", async () => {
    const anchorEl = document.createElement("button");
    document.body.append(anchorEl);
    const { onClose } = open({ anchorEl });
    await placed();

    // The toggle that opened it: its click is the caller's to interpret, or the
    // button would fight its own open/close.
    fireEvent.mouseDown(anchorEl);
    // Nor does a click on the surface itself count as leaving it.
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    anchorEl.remove();
  });

  it("hands dismissal over while something nested owns it", async () => {
    const { onClose } = open({ dismissable: false });
    await placed();

    // A row's context menu is portalled elsewhere, so every click and Escape
    // meant for it reads as "outside" this surface.
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
