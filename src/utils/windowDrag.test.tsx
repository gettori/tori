// Which presses move the window and which are left alone.
//
// The bug this replaces was invisible in a test and in the browser both: the
// titlebar asked for a drag two ways at once (`data-tauri-drag-region`, whose
// script only fires when the press lands on the marked element, and
// `-webkit-app-region`, which is Electron's), and every pixel of the bar is
// covered by a child, so neither ever ran. What can be pinned here is the
// decision, which is the part that has to keep holding as chrome is added.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const dragged = vi.fn();
const zoomed = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => (dragged(), Promise.resolve()),
    toggleMaximize: () => (zoomed(), Promise.resolve()),
  }),
}));

const { windowDragStart } = await import("./windowDrag");

/** A mousedown on `el`, with `detail` 2 standing in for a double click. */
function press(el: Element, init: MouseEventInit = {}) {
  const e = new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, ...init });
  Object.defineProperty(e, "target", { value: el });
  windowDragStart(e);
  return e;
}

function bar(html: string) {
  const el = document.createElement("header");
  el.innerHTML = html;
  return el;
}

beforeEach(() => {
  dragged.mockClear();
  zoomed.mockClear();
});

describe("dragging the window by its chrome", () => {
  it("drags from a press on the bar itself", () => {
    press(bar(""));
    expect(dragged).toHaveBeenCalledTimes(1);
  });

  it("drags from the inert text inside it", () => {
    // The whole reason the old attribute never fired: the press lands on a
    // crumb, never on the bar.
    const el = bar("<nav><span>main</span></nav>");
    press(el.querySelector("span")!);
    expect(dragged).toHaveBeenCalledTimes(1);
  });

  it("zooms instead on the second press of a double click", () => {
    press(bar(""), { detail: 2 });
    expect(zoomed).toHaveBeenCalledTimes(1);
    expect(dragged).not.toHaveBeenCalled();
  });

  it("leaves controls alone, wherever in the press they sit", () => {
    const el = bar('<button><span class="glyph">x</span></button>');
    press(el.querySelector(".glyph")!);
    expect(dragged).not.toHaveBeenCalled();
  });

  it("leaves a marked subtree alone", () => {
    // The session tree's rows are clickable `div`s, which no selector can tell
    // from chrome, so they opt out by hand.
    const el = bar('<div data-no-window-drag><div class="row">a branch</div></div>');
    press(el.querySelector(".row")!);
    expect(dragged).not.toHaveBeenCalled();
  });

  it("ignores the right button, which opens menus", () => {
    press(bar(""), { button: 2 });
    expect(dragged).not.toHaveBeenCalled();
  });
});
