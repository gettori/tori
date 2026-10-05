// The one move rule (#159 phase 1). Drag and Move up / Move down commit the
// same call, so the keyboard route cannot land somewhere the pointer would not.
import { describe, it, expect, vi } from "vite-plus/test";
import { createRoot } from "solid-js";
import { moveKey, createDragReorder } from "./dragReorder";

const KEYS = ["a", "b", "c", "d"];

describe("moveKey", () => {
  it("puts the moved key where the target sat, forwards and backwards", () => {
    expect(moveKey(KEYS, "d", "a")).toEqual(["d", "a", "b", "c"]);
    expect(moveKey(KEYS, "a", "d")).toEqual(["b", "c", "d", "a"]);
    expect(moveKey(KEYS, "b", "c")).toEqual(["a", "c", "b", "d"]);
  });

  it("answers a copy, unchanged, when there is nothing to do", () => {
    expect(moveKey(KEYS, "b", "b")).toEqual(KEYS);
    expect(moveKey(KEYS, "z", "a")).toEqual(KEYS);
    expect(moveKey(KEYS, "a", "z")).toEqual(KEYS);
    expect(moveKey(KEYS, "a", "b")).not.toBe(KEYS);
  });
});

/** The parts of a DragEvent the handlers touch. */
const evt = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: null }) as never;

describe("createDragReorder", () => {
  it("commits the dropped order once and marks the click that follows", () =>
    createRoot((dispose) => {
      const onCommit = vi.fn();
      const drag = createDragReorder({ keys: () => KEYS, onCommit });

      drag.rowProps("d").onDragStart(evt());
      expect(drag.dragging()).toBe("d");
      drag.rowProps("a").onDragOver(evt());
      expect(drag.over()).toBe("a");
      drag.rowProps("a").onDrop(evt());

      expect(onCommit).toHaveBeenCalledExactlyOnceWith(["d", "a", "b", "c"]);
      expect(drag.dragging()).toBeNull();
      // The window a click landing right after the drop falls in.
      expect(drag.fromDrag()).toBe(true);
      dispose();
    }));

  it("ignores a drop on the row the drag started from", () =>
    createRoot((dispose) => {
      const onCommit = vi.fn();
      const drag = createDragReorder({ keys: () => KEYS, onCommit });

      drag.rowProps("b").onDragStart(evt());
      drag.rowProps("b").onDragOver(evt());
      expect(drag.over()).toBeNull();
      drag.rowProps("b").onDrop(evt());

      expect(onCommit).not.toHaveBeenCalled();
      dispose();
    }));

  it("leaves an ordinary click alone once the drag has settled", () =>
    createRoot(async (dispose) => {
      const drag = createDragReorder({ keys: () => KEYS, onCommit: vi.fn() });
      drag.rowProps("a").onDragStart(evt());
      drag.rowProps("a").onDragEnd(evt());
      expect(drag.fromDrag()).toBe(true);

      await new Promise((r) => setTimeout(r, 0));
      expect(drag.fromDrag()).toBe(false);
      dispose();
    }));
});
