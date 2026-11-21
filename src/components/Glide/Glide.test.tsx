import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render } from "../../test/harness";
import { For, createSignal } from "solid-js";
import Glide from "./Glide";

const ROW = 24;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

let observing = 0;

beforeEach(() => {
  observing = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      constructor() {
        observing++;
      }
      disconnect() {
        observing--;
      }
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

// jsdom lays nothing out, so each row reports the offsets a 24px row would.
function mount() {
  const [index, setIndex] = createSignal(0);
  const { container } = render(() => (
    <div role="listbox">
      <Glide active={(list) => list.querySelectorAll('[role="option"]')[index()]} />
      <For each={["one", "two", "three"]}>
        {(name, i) => (
          <div
            role="option"
            ref={(el) => {
              Object.defineProperty(el, "offsetTop", { value: i() * ROW });
              Object.defineProperty(el, "offsetHeight", { value: ROW });
            }}
          >
            {name}
          </div>
        )}
      </For>
    </div>
  ));
  const list = container.querySelector('[role="listbox"]') as HTMLElement;
  return { list, fill: list.firstElementChild as HTMLElement, setIndex };
}

describe("Glide", () => {
  it("glides to a row the pointer moved onto", async () => {
    const { list, fill, setIndex } = mount();
    await frame();
    expect(fill.hasAttribute("data-shown")).toBe(true);
    expect(fill.hasAttribute("data-glide")).toBe(false);

    fireEvent.pointerMove(list, { movementX: 4, movementY: 4 });
    setIndex(2);
    await frame();
    expect(fill.hasAttribute("data-glide")).toBe(true);
    expect(fill.style.transform).toBe(`translate(0px, ${2 * ROW}px)`);
  });

  it("jumps to a row a key moved onto", async () => {
    const { fill, setIndex } = mount();
    await frame();
    setIndex(1);
    await frame();
    expect(fill.hasAttribute("data-glide")).toBe(false);
    expect(fill.style.transform).toBe(`translate(0px, ${ROW}px)`);
  });

  it("hides with no active row and stops observing the list", async () => {
    const { fill, setIndex } = mount();
    await frame();
    expect(observing).toBe(1);

    setIndex(-1);
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fill.hasAttribute("data-shown")).toBe(false);
    expect(observing).toBe(0);
  });
});
