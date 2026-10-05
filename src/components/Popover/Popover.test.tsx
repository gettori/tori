import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import Popover from "./Popover";
import { expectNoAxeViolations } from "../../test/axe";

// The old hand-rolled suite pinned pixel placement (style.left, the opacity
// dance), which was that implementation's own RAF clamp. Position now belongs
// to floating-ui, which jsdom cannot exercise past "it mounted", so what this
// suite holds is the wrapper's actual contract: who dismisses it, who gets
// focus, and what the anchor's own press means. The panel-level invariants live
// in HistoryPanel.test.tsx.
//
// Kobalte installs its outside listener from a setTimeout(0) and listens for
// pointerdown, so dismissal tests yield a macrotask first and fire the
// pointerdown/mousedown pair a real pointer sends (see test/menuIdioms.test.ts).
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(over: Partial<Parameters<typeof Popover>[0]> = {}) {
  const onClose = vi.fn();
  const anchorEl = document.createElement("button");
  anchorEl.textContent = "toggle";
  document.body.append(anchorEl);
  const r = render(() => (
    <Popover anchorEl={anchorEl} onClose={onClose} aria-label="Test" {...over}>
      <button>inside</button>
    </Popover>
  ));
  return {
    onClose,
    anchorEl,
    ...r,
    unmount: () => {
      r.unmount();
      anchorEl.remove();
    },
  };
}

describe("Popover", () => {
  it("portals a labelled dialog to the body", () => {
    const { container, unmount } = open();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByRole("dialog", { name: "Test" })).toBeTruthy();
    unmount();
  });

  it("closes on Escape and on an outside press, but not on the anchor's own", async () => {
    const { onClose, anchorEl, unmount } = open();
    await settle();

    // The toggle that opened it: its press is the caller's to interpret, or the
    // button would fight its own open/close.
    fireEvent.pointerDown(anchorEl);
    fireEvent.mouseDown(anchorEl);
    // Nor does a press on the surface itself count as leaving it.
    fireEvent.pointerDown(screen.getByText("inside"));
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("focuses what initialFocus names, and hands focus back on unmount", async () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();

    const { unmount } = open({
      initialFocus: () => screen.queryByText("inside") ?? undefined,
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("inside")));

    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("exposes the content element through ref", () => {
    let el: HTMLDivElement | undefined;
    const { unmount } = open({ ref: (node) => (el = node) });
    expect(el).toBe(screen.getByRole("dialog", { name: "Test" }));
    unmount();
  });

  // Body-scoped, because the surface portals out of its render container; see
  // the scope section of src/test/axe.ts.
  it("passes the axe gate", async () => {
    const { unmount } = open();
    await expectNoAxeViolations(document.body);
    unmount();
  });
});
