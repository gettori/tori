import { describe, it, expect } from "vite-plus/test";
import { createEvent, fireEvent, render } from "@solidjs/testing-library";
import { createSidebarDrag, zoneAt, type DragCommit } from "./sidebarDrag";
import { DRAG_ABS_PATH_MIME } from "../../utils/events";

function transfer() {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: "none",
    dropEffect: "none",
    setData: (type: string, value: string) => (data[type] = value),
    getData: (type: string) => data[type] ?? "",
  };
}

function fire(el: Element, type: "dragStart" | "dragOver" | "drop", dt: ReturnType<typeof transfer>, y = 0) {
  const ev = createEvent[type](el, { clientY: y });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  // jsdom's DragEvent drops `clientY` from its init.
  Object.defineProperty(ev, "clientY", { value: y });
  fireEvent(el, ev);
}

function mount(groupable = false) {
  const commits: DragCommit[] = [];
  const view = render(() => {
    const drag = createSidebarDrag({ onCommit: (c) => commits.push(c) });
    return (
      <div>
        <div data-testid="a" {...drag.rowProps({ key: "a", section: "main", index: 0, paths: "/w/a" })} />
        <div
          data-testid="b"
          {...drag.rowProps({ key: "b", section: "lane:done", index: 3, paths: "/w/b", groupable })}
        />
      </div>
    );
  });
  const b = view.getByTestId("b");
  b.getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect;
  return { commits, a: view.getByTestId("a"), b };
}

describe("zoneAt", () => {
  it("splits a plain row in halves and gives a groupable row's middle to grouping", () => {
    expect(zoneAt(100, 40, 105, false)).toBe("top");
    expect(zoneAt(100, 40, 125, false)).toBe("bottom");
    expect(zoneAt(100, 40, 105, true)).toBe("top");
    expect(zoneAt(100, 40, 120, true)).toBe("middle");
    expect(zoneAt(100, 40, 135, true)).toBe("bottom");
  });
});

describe("createSidebarDrag", () => {
  it("commits a move into another section, before or after the row it lands on", () => {
    const { commits, a, b } = mount();
    const dt = transfer();
    fire(a, "dragStart", dt);
    fire(b, "dragOver", dt, 132);
    expect(b.getAttribute("data-drop")).toBe("after");
    expect(a.hasAttribute("data-dragging")).toBe(true);
    fire(b, "drop", dt);
    expect(commits).toEqual([{ from: "a", to: { section: "lane:done", index: 4 } }]);
    expect(b.hasAttribute("data-drop")).toBe(false);
  });

  it("groups with a row dropped on its middle", () => {
    const { commits, a, b } = mount(true);
    const dt = transfer();
    fire(a, "dragStart", dt);
    fire(b, "dragOver", dt, 120);
    expect(b.getAttribute("data-drop")).toBe("into");
    fire(b, "drop", dt);
    expect(commits).toEqual([{ from: "a", to: { groupWith: "b" } }]);
  });

  it("still carries the path, so a terminal drop pastes it", () => {
    const { a } = mount();
    const dt = transfer();
    fire(a, "dragStart", dt);
    expect(dt.effectAllowed).toBe("copyMove");
    expect(dt.getData(DRAG_ABS_PATH_MIME)).toBe("/w/a");
    expect(dt.getData("text/plain")).toBe("/w/a");
  });
});
