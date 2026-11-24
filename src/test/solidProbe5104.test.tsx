// Upstream repro of solidjs/solid#5104, ported to run against the pinned solid-js.
/* eslint-disable require-yield -- kept as upstream wrote it, so the repro stays the one filed */
import { test, expect } from "vite-plus/test";
import { For, Show, Errored, Loading, action, refresh, createSignal, createOptimisticStore, flush } from "solid-js";
import { render } from "@solidjs/web";
const tick = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flush();
  }
};

// Fails on 2.0.3 once one re-ask has landed; `test.fails` flips when upstream ships the fix.
for (const W of ["one re-ask has landed", "neither re-ask has landed"])
  (W === "one re-ask has landed" ? test.fails : test)(`a heading counts the guess its list shows (${W})`, async () => {
    const asks: { k: string; res: (v: any) => void }[] = [];
    const ask = (k: string) => new Promise<any>((res) => asks.push({ k, res }));
    const answer = (k: string, v: any) => {
      const i = asks.findIndex((a) => a.k === k);
      asks.splice(i, 1)[0].res(v);
    };
    let api: any;
    function App() {
      const [doingAns] = createSignal(async () => await ask("doing"), { loadingValue: null } as any);
      const [doing, setDoing] = createOptimisticStore(() => doingAns() ?? [], [] as any[], { key: "id" } as any);
      const [doneAns] = createSignal(async () => await ask("done"), { loadingValue: null } as any);
      const [done, setDone] = createOptimisticStore(() => doneAns() ?? [], [] as any[], { key: "id" } as any);
      const reask = action(function* () {
        refresh(doneAns);
        refresh(doingAns);
      }); // an accepted save elsewhere re-asks both
      const move = action(function* () {
        setDone((rs: any[]) => rs.filter((r) => r.id !== 5));
        setDoing((rs: any[]) => [...rs, { id: 5 }]);
      });
      api = { reask, move };
      return (
        <section>
          <h3>{doingAns() != null ? `Doing (${doing.length})` : "Doing"}</h3>
          <Loading fallback={<i>loading</i>}>
            <Errored fallback={<b>error</b>}>
              <Show when={doingAns() != null}>
                <For each={doing}>{(r: any) => <span>#{r.id} </span>}</For>
              </Show>
            </Errored>
          </Loading>
          | done: <For each={done}>{(r: any) => <span>#{r.id} </span>}</For>
        </section>
      );
    }
    const c = document.body.appendChild(document.createElement("div"));
    render(() => <App />, c);
    await tick();
    answer("doing", [{ id: 3 }, { id: 4 }]);
    answer("done", [{ id: 5 }]);
    await tick();
    api.reask();
    await tick();
    if (W === "one re-ask has landed") {
      answer("done", [{ id: 5 }]);
      await tick();
    }
    api.move();
    await tick();
    const s = c.textContent!.replace(/\s+/g, " ").trim();
    const counted = Number(s.match(/Doing \((\d+)\)/)?.[1]);
    const shown = (s.split("|")[0].match(/#\d+ /g) || []).length;
    expect({ counted, shown, s }).toEqual({ counted: shown, shown, s });
  });
