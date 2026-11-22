import { describe, expect, it, vi } from "vite-plus/test";
import { createMemo, createSignal, flush, Show } from "solid-js";
import { render } from "./harness";
import { countMutations, takeRuns } from "./perfCounters";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("./perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});

describe("countMutations", () => {
  it("counts a three node insert as exactly three", () => {
    const root = document.createElement("div");
    const counter = countMutations(root);
    root.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    expect(counter.take()).toEqual({ added: 3, removed: 0, attributes: 0, text: 0 });
    counter.stop();
  });

  it("counts nothing for a signal write that sets the same value", () => {
    const [value, setValue] = createSignal("a");
    const { container } = render(() => <p data-value={value()}>{value()}</p>);
    const counter = countMutations(container);
    setValue("a");
    flush();
    expect(counter.take()).toEqual({ added: 0, removed: 0, attributes: 0, text: 0 });
    counter.stop();
  });
});

describe("the run counter", () => {
  it("counts nothing for a write nobody reads", () => {
    const [, setUnread] = createSignal(0);
    const [read] = createSignal(0);
    render(() => <p data-value={String(createMemo(read)())} />);
    takeRuns();
    setUnread(1);
    flush();
    expect(takeRuns()).toEqual({ memo: 0, effect: 0 });
  });

  it("moves the memo total by one for a write one memo reads", () => {
    const [value, setValue] = createSignal(0);
    const doubled = createMemo(() => value() * 2);
    expect(doubled()).toBe(0);
    takeRuns();
    setValue(1);
    flush();
    expect(doubled()).toBe(2);
    expect(takeRuns()).toEqual({ memo: 1, effect: 0 });
  });

  it("reaches a compiler emitted render effect", () => {
    const [value, setValue] = createSignal("a");
    render(() => <p data-value={value()} />);
    takeRuns();
    setValue("b");
    flush();
    expect(takeRuns().effect).toBe(1);
  });

  it("reaches the render effect behind an inserted expression", () => {
    const [value, setValue] = createSignal("a");
    render(() => <p>{value()}</p>);
    takeRuns();
    setValue("b");
    flush();
    expect(takeRuns().effect).toBe(1);
  });

  it("does not see the memo inside Show", () => {
    const [on, setOn] = createSignal(true);
    render(() => (
      <Show when={on()}>
        <p />
      </Show>
    ));
    takeRuns();
    setOn(false);
    flush();
    expect(takeRuns().memo).toBe(0);
  });
});
