import {
  affects,
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  OBSERVE,
  flush,
  isPending,
  Loading,
  onSettled,
  refresh,
  type Accessor,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { afterEach, describe, it } from "vite-plus/test";
import { cleanup, render } from "../test/harness";

afterEach(cleanup);

type Form = "loadingValue" | "loadingOn" | "signalEffect" | "deferred" | "deferredLoadingValue" | "loadingValueCaught";

const last = <T,>(list: T[]) => list[list.length - 1];
const nodeFs = "node:fs";
const report = async (text: string) => {
  const fs: { appendFileSync: (path: string, text: string) => void } = await import(/* @vite-ignore */ nodeFs);
  fs.appendFileSync("/tmp/solid2-probe.txt", text);
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(form: Form) {
  const calls: { id: number; resolve: (v: string) => void; reject: (e: Error) => void }[] = [];
  const fetchX = (id: number) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ id, resolve, reject });
    });
  const [id, setId] = createSignal(1);
  const [other, setOther] = createSignal("o1");
  const events: string[] = [];
  const codes: string[] = [];
  const stop = OBSERVE!.diagnostics.subscribe((entry: { code: string; severity: string }) => {
    codes.push(`${entry.severity}:${entry.code}`);
  });
  let reload: (declared: boolean) => void = () => {};

  const Row = (props: { v: Accessor<string | undefined>; p: Accessor<boolean> }) => (
    <p>
      v={String(props.v())} pending={String(props.p())}
    </p>
  );

  function Reader(): JSX.Element {
    onSettled(() => {
      events.push("onSettled");
    });
    if (form === "signalEffect") {
      const [value, setValue] = createSignal<string>();
      const [loading, setLoading] = createSignal(false);
      const [nonce, setNonce] = createSignal(0);
      reload = () => setNonce((n) => n + 1);
      createEffect(
        () => [id(), nonce()] as const,
        ([current]) => {
          let live = true;
          setLoading(true);
          fetchX(current).then(
            (v) => {
              if (!live) return;
              setValue(v);
              setLoading(false);
            },
            () => {
              if (live) setLoading(false);
            },
          );
          return () => {
            live = false;
          };
        },
      );
      return <Row v={value} p={loading} />;
    }
    if (form === "loadingValue") {
      const data = createMemo<string | undefined>(() => fetchX(id()), { loadingValue: undefined });
      reload = (declared) => {
        if (declared) affects(data);
        refresh(data);
      };
      return <Row v={data} p={() => isPending(() => data())} />;
    }
    if (form === "deferredLoadingValue") {
      const data = createDeferred<string | undefined>(() => fetchX(id()), { loadingValue: undefined });
      reload = (declared) => {
        if (declared) affects(data);
        refresh(data);
      };
      return <Row v={data} p={() => isPending(() => data())} />;
    }
    if (form === "loadingValueCaught") {
      const data = createMemo<string | undefined>(() => fetchX(id()).catch(() => "CAUGHT"), {
        loadingValue: undefined,
      });
      reload = (declared) => {
        if (declared) affects(data);
        refresh(data);
      };
      return <Row v={data} p={() => isPending(() => data())} />;
    }
    if (form === "deferred") {
      const data = createDeferred(() => fetchX(id()));
      reload = (declared) => {
        if (declared) affects(data);
        refresh(data);
      };
      return (
        <Loading fallback={<p>FALLBACK</p>}>
          <Row v={data} p={() => isPending(() => data())} />
        </Loading>
      );
    }
    const data = createMemo(() => fetchX(id()));
    reload = (declared) => {
      if (declared) affects(data);
      refresh(data);
    };
    return (
      <Loading fallback={<p>FALLBACK</p>} on={id()}>
        <Row v={data} p={() => isPending(() => data())} />
      </Loading>
    );
  }

  const { container } = render(() => (
    <div>
      <Reader />
      <span>other={other()}</span>
    </div>
  ));
  const out: string[] = [];
  const snap = (label: string) => {
    out.push(
      `${label.padEnd(34)} | ${(container.textContent ?? "").replace(/\s+/g, " ").trim() || "(empty)"} | calls=${calls.length} ${events.join(",")}`,
    );
    events.length = 0;
  };
  const settle = async () => {
    await tick();
    flush();
    await tick();
    flush();
  };
  return { calls, setId, setOther, snap, settle, out, codes, stop, reload: (d: boolean) => reload(d) };
}

const FORMS: Form[] = [
  "loadingValue",
  "loadingValueCaught",
  "loadingOn",
  "deferred",
  "deferredLoadingValue",
  "signalEffect",
];

// Rejections here halt Solid and surface as unhandled errors, so this only runs on request.
describe.skipIf(!import.meta.env.VITE_SOLID2_PROBE)("resource port probe", () => {
  for (const form of FORMS) {
    it(`${form}: load, source change, refetch`, async () => {
      const t = setup(form);
      t.snap("mount, fetch pending");
      await t.settle();
      t.snap("still pending after a tick");
      t.calls[0].resolve("one");
      await t.settle();
      t.snap("first answer landed");

      t.setId(2);
      t.setOther("o2");
      flush();
      t.snap("id=2 and other=o2 in one update");
      await t.settle();
      t.snap("a tick later, fetch 2 pending");
      t.setOther("o3");
      flush();
      t.snap("other=o3 while fetch 2 pending");
      last(t.calls).resolve("two");
      await t.settle();
      t.snap("second answer landed");

      t.reload(false);
      flush();
      await t.settle();
      t.snap("bare refetch, pending");
      last(t.calls).resolve("two-b");
      await t.settle();
      t.snap("bare refetch landed");

      t.reload(true);
      flush();
      await t.settle();
      t.snap("declared refetch, pending");
      last(t.calls).resolve("two-c");
      await t.settle();
      t.snap("declared refetch landed");

      t.stop();
      await report(`\n== ${form}\n${t.out.join("\n")}\ndiagnostics: ${t.codes.join(" ") || "none"}`);
    });

    it(`${form}: rejection`, async () => {
      const t = setup(form);
      const errors: string[] = [];
      const onError = (e: ErrorEvent) => {
        errors.push(String(e.message));
        e.preventDefault();
      };
      window.addEventListener("error", onError);
      t.calls[0].resolve("one");
      await t.settle();
      t.setId(2);
      flush();
      await t.settle();
      last(t.calls).reject(new Error("boom"));
      await t.settle();
      t.snap("fetch 2 rejected");
      t.setOther("after");
      flush();
      await t.settle();
      t.snap("other=after, after the rejection");
      t.setId(3);
      flush();
      await t.settle();
      last(t.calls).resolve("three");
      await t.settle();
      t.snap("id=3 answered after the rejection");
      window.removeEventListener("error", onError);
      t.stop();
      await report(
        `\n== ${form} rejection\n${t.out.join("\n")}\ndiagnostics: ${t.codes.join(" ") || "none"}\nwindow errors: ${errors.join(" | ") || "none"}`,
      );
    });
  }
});
