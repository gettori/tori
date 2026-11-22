import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRoot, createSignal, flush, For, onCleanup } from "solid-js";
import { cleanup, fireEvent, render, screen } from "../test/harness";
import { createItemOrder, createRovingFocus, createTypeahead, type RovingFocusOptions } from "./keyboard";

afterEach(cleanup);

function Group(props: { keys: () => string[] } & Omit<RovingFocusOptions, "keys">) {
  const roving = createRovingFocus({
    get orientation() {
      return props.orientation;
    },
    get wrap() {
      return props.wrap;
    },
    get rootTabStop() {
      return props.rootTabStop;
    },
    keys: () => props.keys(),
    selected: () => props.selected?.(),
  });
  return (
    <div role="group" aria-label="Items" {...roving.root}>
      <For each={props.keys()}>{(key) => <button {...roving.item(key)}>{key}</button>}</For>
    </div>
  );
}

const item = (name: string) => screen.getByRole("button", { name });
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

describe("createRovingFocus", () => {
  it("moves with the arrows of its orientation only", () => {
    render(() => <Group keys={() => ["a", "b"]} orientation="horizontal" />);
    item("a").focus();

    press("ArrowDown");
    expect(document.activeElement).toBe(item("a"));
    press("ArrowRight");
    expect(document.activeElement).toBe(item("b"));
    press("ArrowLeft");
    expect(document.activeElement).toBe(item("a"));
  });

  it("moves vertically, and on both axes", () => {
    render(() => <Group keys={() => ["a", "b", "c"]} orientation="vertical" />);
    item("a").focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(item("a"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("b"));
    cleanup();

    render(() => <Group keys={() => ["a", "b", "c"]} orientation="both" />);
    item("a").focus();
    press("ArrowDown");
    press("ArrowRight");
    expect(document.activeElement).toBe(item("c"));
    press("ArrowUp");
    expect(document.activeElement).toBe(item("b"));
  });

  it("jumps with Home and End", () => {
    render(() => <Group keys={() => ["a", "b", "c"]} orientation="horizontal" />);
    item("b").focus();

    press("End");
    expect(document.activeElement).toBe(item("c"));
    press("Home");
    expect(document.activeElement).toBe(item("a"));
  });

  it("stops at the edges unless told to wrap", () => {
    render(() => <Group keys={() => ["a", "b"]} orientation="horizontal" />);
    item("b").focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(item("b"));
    cleanup();

    render(() => <Group keys={() => ["a", "b"]} orientation="horizontal" wrap />);
    item("b").focus();
    press("ArrowRight");
    expect(document.activeElement).toBe(item("a"));
    press("ArrowLeft");
    expect(document.activeElement).toBe(item("b"));
  });

  it("leaves an event a child already prevented", () => {
    render(() => <Group keys={() => ["a", "b"]} orientation="horizontal" />);
    item("a").focus();
    item("a").addEventListener("keydown", (e) => e.preventDefault());

    press("ArrowRight");

    expect(document.activeElement).toBe(item("a"));
  });

  it("holds the stop on the root until an item takes focus, entering on the selected one", () => {
    render(() => <Group keys={() => ["a", "b"]} selected={() => "b"} orientation="horizontal" rootTabStop />);
    const group = screen.getByRole("group");
    expect(group.getAttribute("tabindex")).toBe("0");
    expect(item("b").getAttribute("tabindex")).toBe("-1");

    group.focus();
    flush();

    expect(document.activeElement).toBe(item("b"));
    expect(group.getAttribute("tabindex")).toBe("-1");
    expect(item("b").getAttribute("tabindex")).toBe("0");
    expect(item("a").getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the stop on the selected item when the root has none", () => {
    render(() => <Group keys={() => ["a", "b"]} selected={() => "b"} orientation="horizontal" />);

    expect(screen.getByRole("group").hasAttribute("tabindex")).toBe(false);
    expect(item("a").getAttribute("tabindex")).toBe("-1");
    expect(item("b").getAttribute("tabindex")).toBe("0");
  });

  it("hands the stop back to the root when the focused item unmounts", () => {
    const [keys, setKeys] = createSignal(["a", "b"]);
    render(() => <Group keys={keys} orientation="horizontal" rootTabStop />);
    const group = screen.getByRole("group");
    item("b").focus();
    flush();
    expect(group.getAttribute("tabindex")).toBe("-1");

    setKeys(["a"]);
    flush();

    expect(group.getAttribute("tabindex")).toBe("0");
  });

  it("hands the stop to the entry item when the focused item unmounts and the root has none", () => {
    const [keys, setKeys] = createSignal(["a", "b", "c"]);
    render(() => <Group keys={keys} selected={() => "a"} orientation="horizontal" />);
    item("b").focus();
    flush();
    expect(item("b").getAttribute("tabindex")).toBe("0");

    setKeys(["a", "c"]);
    flush();

    expect(item("a").getAttribute("tabindex")).toBe("0");
    expect(item("c").getAttribute("tabindex")).toBe("-1");
  });
});

describe("createTypeahead", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(keys = ["Alpha", "Beta", "Bravo", "Charlie"]) {
    const [current, setCurrent] = createSignal<string | null>(null);
    const onMatch = vi.fn((key: string) => setCurrent(key));
    let dispose!: () => void;
    const type = createRoot((d) => {
      dispose = d;
      return createTypeahead({ keys: () => keys, text: (key) => key, current, onMatch });
    });
    const key = (value: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { ...init, key: value, cancelable: true, bubbles: true });
      type(event);
      flush();
      return event;
    };
    return { key, onMatch, current, dispose };
  }

  it("matches a growing prefix, ignoring case", () => {
    const { key, current, dispose } = setup();

    key("b");
    expect(current()).toBe("Beta");
    key("R");
    expect(current()).toBe("Bravo");
    dispose();
  });

  it("starts a new search after the reset delay", () => {
    const { key, current, dispose } = setup();
    key("b");

    vi.advanceTimersByTime(500);
    key("c");

    expect(current()).toBe("Charlie");
    dispose();
  });

  it("keeps building the search inside the reset delay", () => {
    const { key, onMatch, dispose } = setup();
    key("b");
    vi.advanceTimersByTime(499);
    onMatch.mockClear();

    key("c");

    expect(onMatch).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves a leading space to the control, and takes one inside a search", () => {
    const { key, current, dispose } = setup(["New file", "New folder"]);

    expect(key(" ").defaultPrevented).toBe(false);
    key("n");
    key("e");
    key("w");
    expect(key(" ").defaultPrevented).toBe(true);
    key("f");
    key("o");
    expect(current()).toBe("New folder");
    dispose();
  });

  it("ignores shortcuts and composition", () => {
    const { key, onMatch, dispose } = setup();

    key("b", { metaKey: true });
    key("b", { ctrlKey: true });
    key("b", { isComposing: true });

    expect(onMatch).not.toHaveBeenCalled();
    dispose();
  });
});

describe("createItemOrder", () => {
  it("drops an item from the order when the component that registered it unmounts", () => {
    const order = createRoot(() => createItemOrder());
    const [shown, setShown] = createSignal(["a", "b", "c"]);
    function Row(props: { name: string }) {
      let unregister: (() => void) | undefined;
      onCleanup(() => unregister?.());
      return (
        <button
          ref={(element) => {
            unregister = order.register({ key: props.name, element, disabled: () => false });
          }}
        >
          {props.name}
        </button>
      );
    }
    render(() => <For each={shown()}>{(name) => <Row name={name} />}</For>);
    flush();
    expect(order.keys()).toEqual(["a", "b", "c"]);

    setShown(["a", "c"]);
    flush();

    expect(order.keys()).toEqual(["a", "c"]);
  });
});
