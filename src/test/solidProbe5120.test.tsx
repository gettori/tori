// Upstream solidjs/solid#5120 on the pinned solid-js: releasing an owner that
// iterated a store array lists the remaining has-keys on every release. Counted,
// never timed: the work for one removed row must not grow with the list.
import { afterEach, describe, expect, it, test, vi } from "vite-plus/test";
import { For, createMemo, createStore, flush, onCleanup, untrack } from "solid-js";
import { render } from "@solidjs/web";

type Item = { id: number; on: boolean };
const items = (n: number) => Array.from({ length: n }, (_, id) => ({ id, on: id % 2 === 0 }));

afterEach(() => {
  vi.restoreAllMocks();
});

function removeFirst(n: number, rowIteratesStore: boolean, storeSource: boolean) {
  const [state, setState] = createStore({ items: items(n) });
  let cleanups = 0;
  const el = document.body.appendChild(document.createElement("div"));
  const row = (item: Item) => {
    onCleanup(() => cleanups++);
    if (rowIteratesStore && untrack(() => item.id === 0)) {
      const on = createMemo(() => state.items.filter((x) => x.on).length);
      return <i>{on()}</i>;
    }
    return <i>{item.id}</i>;
  };
  const Copied = () => {
    const rows = createMemo(() => state.items.filter(() => true));
    return <For each={rows()}>{row}</For>;
  };
  const dispose = render(() => (storeSource ? <For each={state.items}>{row}</For> : <Copied />), el);
  flush();
  const ownKeys = vi.spyOn(Reflect, "ownKeys");
  setState((s) => void s.items.splice(0, 1));
  flush();
  const work = { cleanups, ownKeys: ownKeys.mock.calls.length };
  ownKeys.mockRestore();
  dispose();
  el.remove();
  return work;
}

describe("removing one row", () => {
  it("costs the same at 1k and 10k for a list fed a copy, as MessageList's rows are", () => {
    expect(removeFirst(10_000, false, false)).toEqual(removeFirst(1_000, false, false));
  });

  test.fails("costs the same at 1k and 10k when the row iterated the store array (solidjs/solid 5120)", () => {
    expect(removeFirst(10_000, true, true)).toEqual(removeFirst(1_000, true, true));
  });
});
