// Upstream repro of solidjs/solid#5118, ported to run against the pinned solid-js. Every case fails on
// 2.0.3, so each is `test.fails`: one turning red means upstream fixed it and its mutation shapes can be revisited.
/* eslint-disable require-yield, solid/no-unused-signal, solid/reactivity -- kept as upstream wrote it, so the repro stays the one filed */
import { expect, test } from "vite-plus/test";
import {
  Loading,
  action,
  createDeferred,
  createMemo,
  createOptimistic,
  createSignal,
  flush,
  latest,
  untrack,
} from "solid-js";
import { render } from "@solidjs/web";

const tick = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flush();
  }
};

function desk() {
  const asks: { key: string; res: (v: any) => void }[] = [];
  const ask = (key: string) => new Promise<any>((res) => asks.push({ key, res }));
  const land = async (key: string, v: any = key) => {
    const i = asks.findIndex((a) => a.key === key);
    if (i < 0) throw new Error(`no ask ${key}; open: ${asks.map((a) => a.key)}`);
    asks.splice(i, 1)[0].res(v);
    await tick();
  };
  const drain = async () => {
    for (let n = 0; n < 30 && asks.length; n++) {
      for (const a of asks.splice(0)) a.res(a.key);
      await tick();
    }
  };
  return { ask, land, drain, open: () => asks.map((a) => a.key).join(",") };
}

function mount(view: () => any) {
  const container = document.body.appendChild(document.createElement("div"));
  const dispose = render(view, container);
  return {
    frame: () => container.textContent!.replace(/\s+/g, " ").trim(),
    dispose: () => (dispose(), container.remove()),
  };
}

test.fails("H: a guess during an unrendered first load does not reveal <Loading> with an empty hole", async () => {
  const d = desk();
  let guess!: (x: string) => void;
  const app = mount(() => {
    const a1 = createMemo(() => d.ask("a1"));
    const a2 = createMemo(() => d.ask("a2"));
    const [, setQ] = createOptimistic(() => d.ask("q:" + a1()));
    guess = action(function* (x: string) {
      setQ(x);
    });
    return (
      <Loading fallback="LOADING">
        <div>
          [a1={a1()}] [a2={a2()}]
        </div>
      </Loading>
    );
  });
  flush();
  await tick();
  guess("G");
  flush();
  await tick();
  await d.land("a1");
  await d.land("a2");
  const mid = app.frame();
  await d.drain();
  app.dispose();
  expect(["[a1=a1] [a2=a2]", "LOADING"]).toContain(mid);
});

test.fails("resolveTx: a guess during a first load read through createDeferred does not crash", async () => {
  const d = desk();
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...a: any[]) => void errs.push(String(a[0]).split("\n")[0] + " " + String(a[1]?.message ?? ""));
  let setS!: (v: number) => void, act!: (v: number) => void;
  const app = mount(() => {
    const [s, b] = createSignal(0);
    setS = b;
    const [o, setO] = createOptimistic(() => d.ask("o:" + latest(s)));
    const f = createDeferred(() => o());
    act = action(function* (v: number) {
      setO("G" + v);
    });
    return <i>[f={f()}]</i>;
  });
  await tick();
  for (const fn of [() => setS(2), () => act(3), () => setS(3)]) {
    try {
      fn();
      flush();
      await tick();
    } catch (e: any) {
      errs.push(e?.message);
    }
  }
  try {
    await d.drain();
  } catch (e: any) {
    errs.push(e?.message);
  }
  console.error = origError;
  const settled = app.frame();
  app.dispose();
  expect({ errs, settled }).toEqual({ errs: [], settled: "[f=o:3]" });
});

test.fails("R4C-1: latest() of a sync optimistic signal reverts when the action also guessed a first-loading node", async () => {
  const d = desk();
  let act!: (v: number) => void, o0!: () => number;
  const app = mount(() => {
    const [, setQ] = createOptimistic(() => d.ask("q0"));
    const [o, setO] = createOptimistic(0);
    o0 = o;
    act = action(function* (v: number) {
      setQ("G");
      setO(v * 10);
      yield d.ask("w");
    });
    return (
      <div>
        [o0={String(o())}][Lo0={String(latest(o))}]
      </div>
    );
  });
  await tick();
  act(3);
  flush();
  await tick();
  await d.drain();
  await tick();
  const settled = app.frame();
  const untracked = untrack(() => latest(o0));
  app.dispose();
  expect({ settled, untracked }).toEqual({ settled: "[o0=0][Lo0=0]", untracked: 0 });
});
