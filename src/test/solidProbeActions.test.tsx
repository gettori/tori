// The action and optimistic shapes the app's mutations use, on the pinned solid-js. A failure here
// means a shape in use is no longer safe.
import { describe, expect, it } from "vite-plus/test";
import {
  For,
  Loading,
  action,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createSignal,
  flush,
  refresh,
} from "solid-js";
import { render } from "@solidjs/web";

const tick = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flush();
  }
};

function backend<T>(initial: T) {
  let stored = initial;
  const writes: { value: T; done: (ok: boolean) => void }[] = [];
  return {
    read: () => Promise.resolve(stored),
    write: (value: T) =>
      new Promise<void>((yes, no) =>
        writes.push({
          value,
          done: (ok) => {
            if (ok) stored = value;
            if (ok) yes();
            else no(new Error("refused"));
          },
        }),
      ),
    settle: async (ok: boolean) => {
      writes.shift()!.done(ok);
      await tick();
    },
  };
}

function mount(view: () => unknown) {
  const el = document.body.appendChild(document.createElement("div"));
  const dispose = render(view as () => Element, el);
  return { text: () => el.textContent!.replace(/\s+/g, " ").trim(), dispose: () => (dispose(), el.remove()) };
}

describe("write, then refresh the read", () => {
  for (const ok of [true, false]) {
    it(`${ok ? "commits the new answer" : "keeps the old answer"} once the action ${ok ? "lands" : "fails"}`, async () => {
      const db = backend("a");
      let save!: (v: string) => Promise<void>;
      const app = mount(() => {
        const name = createMemo(() => db.read());
        const [saving, setSaving] = createOptimistic(false);
        save = action(function* (v: string) {
          setSaving(true);
          yield db.write(v);
          refresh(name);
        });
        return (
          <Loading fallback="loading">
            [{name()}]{saving() ? " saving" : ""}
          </Loading>
        );
      });
      await tick();
      expect(app.text()).toBe("[a]");

      const done = save("b").catch(() => "rejected");
      await tick();
      expect(app.text()).toBe("[a] saving");

      await db.settle(ok);
      expect(await done).toBe(ok ? undefined : "rejected");
      await tick();
      expect(app.text()).toBe(ok ? "[b]" : "[a]");
      app.dispose();
    });
  }
});

describe("a guess on one optimistic list after its first answer", () => {
  for (const ok of [true, false]) {
    it(`shows the guess at once, then ${ok ? "the stored list" : "the old list"}`, async () => {
      const db = backend([{ id: 1, t: "one" }]);
      let add!: (row: { id: number; t: string }) => Promise<void>;
      const app = mount(() => {
        const [rows, setRows] = createOptimisticStore(() => db.read(), [] as { id: number; t: string }[], {
          key: "id",
        });
        add = action(function* (row: { id: number; t: string }) {
          setRows((list) => void list.push(row));
          yield db.write([...rows, row]);
          refresh(rows);
        });
        return (
          <Loading fallback="loading">
            <For each={rows}>{(r) => <i>[{r.t}]</i>}</For>
          </Loading>
        );
      });
      await tick();
      expect(app.text()).toBe("[one]");

      const done = add({ id: 2, t: "two" }).catch(() => "rejected");
      await tick();
      expect(app.text()).toBe("[one][two]");

      await db.settle(ok);
      await done;
      await tick();
      expect(app.text()).toBe(ok ? "[one][two]" : "[one]");
      app.dispose();
    });
  }
});

describe("a plain signal written inside a failing action", () => {
  // Only optimistic writes revert, so a mutation that must undo on failure guesses through one.
  it("is committed anyway", async () => {
    const db = backend(0);
    let bump!: () => Promise<void>;
    const [count, setCount] = createSignal(0);
    const app = mount(() => {
      bump = action(function* () {
        setCount(1);
        yield db.write(1);
      });
      return <b>{count()}</b>;
    });
    await tick();
    const done = bump().catch(() => "rejected");
    await db.settle(false);
    expect(await done).toBe("rejected");
    await tick();
    expect(app.text()).toBe("1");
    app.dispose();
  });
});

describe("a guess over a plain signal the action writes once the save lands", () => {
  for (const ok of [true, false]) {
    it(`shows the guess at once, then ${ok ? "keeps it" : "drops it"} once the action ${ok ? "lands" : "fails"}`, async () => {
      const db = backend(false);
      let use!: (on: boolean) => Promise<void>;
      const app = mount(() => {
        const [saved, setSaved] = createSignal<boolean | null>(null);
        const [on, setOn] = createOptimistic(() => saved() ?? false);
        use = action(function* (next: boolean) {
          setOn(next);
          try {
            yield db.write(next);
          } catch {
            return;
          }
          setSaved(next);
        });
        return <b>{on() ? "on" : "off"}</b>;
      });
      await tick();
      const done = use(true);
      await tick();
      expect(app.text()).toBe("on");

      await db.settle(ok);
      await done;
      await tick();
      expect(app.text()).toBe(ok ? "on" : "off");
      app.dispose();
    });
  }
});
