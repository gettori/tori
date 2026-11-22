// The one move rule (#159 phase 1). Drag and Move up / Move down commit the
// same call, so the keyboard route cannot land somewhere the pointer would not.
import { describe, it, expect, vi } from "vite-plus/test";
import { createRoot, flush } from "solid-js";
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

const mounted = (onCommit: (keys: string[]) => void) =>
  createRoot((dispose) => ({ drag: createDragReorder({ keys: () => KEYS, onCommit }), dispose }));

const act = (handler: (e: never) => void) => {
  handler(evt());
  flush();
};

describe("createDragReorder", () => {
  it("commits the dropped order once and marks the click that follows", () => {
    const onCommit = vi.fn();
    const { drag, dispose } = mounted(onCommit);

    act(drag.rowProps("d").onDragStart);
    expect(drag.dragging()).toBe("d");
    act(drag.rowProps("a").onDragOver);
    expect(drag.over()).toBe("a");
    act(drag.rowProps("a").onDrop);

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(["d", "a", "b", "c"]);
    expect(drag.dragging()).toBeNull();
    // The window a click landing right after the drop falls in.
    expect(drag.fromDrag()).toBe(true);
    dispose();
  });

  it("ignores a drop on the row the drag started from", () => {
    const onCommit = vi.fn();
    const { drag, dispose } = mounted(onCommit);

    act(drag.rowProps("b").onDragStart);
    act(drag.rowProps("b").onDragOver);
    expect(drag.over()).toBeNull();
    act(drag.rowProps("b").onDrop);

    expect(onCommit).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves an ordinary click alone once the drag has settled", async () => {
    const { drag, dispose } = mounted(vi.fn());
    act(drag.rowProps("a").onDragStart);
    act(drag.rowProps("a").onDragEnd);
    expect(drag.fromDrag()).toBe(true);

    await new Promise((r) => setTimeout(r, 0));
    expect(drag.fromDrag()).toBe(false);
    dispose();
  });
});
