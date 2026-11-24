import { captureArtifact, type DiagnosticsArtifact } from "@solidjs/diagnostics";
import "@solidjs/diagnostics/vitest";
import { drift, rows } from "./perfBudgets";

export interface MutationCount {
  added: number;
  removed: number;
  attributes: number;
  text: number;
}

export interface RunCount {
  memo: number;
  effect: number;
}

export interface ListChurn {
  store: boolean;
  length: number;
  first: unknown;
  made: number;
  disposed: number;
}

export interface RenderCost {
  mutations: number;
  memos: number;
  effects: number;
  reruns: number;
}

// Mount work deferred by a timer lands inside a shorter window and moves the
// counts: chat read 34 mutations at 100ms and 4 at 30, 500 and 1500.
const SETTLE_MS = 500;
export const settled = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

export async function renderCost(
  root: Node,
  act: () => unknown,
): Promise<{ cost: RenderCost; artifact: DiagnosticsArtifact; lists: ListChurn[] }> {
  await settled();
  const counter = countMutations(root);
  takeRuns();
  const before = new Map(lists.map((list) => [list, { made: list.made, disposed: list.disposed }]));
  const { artifact } = await captureArtifact(async () => {
    await act();
    await settled();
  });
  const { added, removed, attributes, text } = counter.take();
  const { memo, effect } = takeRuns();
  counter.stop();
  const reruns = artifact.attribution?.reruns.length ?? 0;
  const churn = lists.flatMap((list) => {
    const was = before.get(list) ?? { made: 0, disposed: 0 };
    return [{ ...list, made: list.made - was.made, disposed: list.disposed - was.disposed }];
  });
  return {
    cost: { mutations: added + removed + attributes + text, memos: memo, effects: effect, reruns },
    artifact,
    lists: churn,
  };
}

export const rowsChurned = (lists: ListChurn[]) =>
  lists.flatMap(({ store, made, disposed }) => (made || disposed ? [{ store, made, disposed }] : []));

export function rerunBudget(scenario: string): number {
  const name = `renders.${scenario}.reruns`;
  const row = rows("webview").find((r) => r.name === name);
  if (!row) throw new Error(`no budget row named ${name}`);
  return row.budget;
}

export function renderDrift(scenario: string, cost: RenderCost): string[] {
  const prefix = `renders.${scenario}.`;
  return drift(
    rows("webview").filter((row) => row.name.startsWith(prefix)),
    new Map(Object.entries(cost).map(([kind, value]) => [prefix + kind, value])),
  );
}

export function countMutations(root: Node) {
  const count: MutationCount = { added: 0, removed: 0, attributes: 0, text: 0 };
  const tally = (records: MutationRecord[]) => {
    for (const record of records) {
      count.added += record.addedNodes.length;
      count.removed += record.removedNodes.length;
      if (record.type === "attributes") count.attributes++;
      if (record.type === "characterData") count.text++;
    }
  };
  const observer = new MutationObserver(tally);
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  return {
    take(): MutationCount {
      tally(observer.takeRecords());
      const taken = { ...count };
      count.added = count.removed = count.attributes = count.text = 0;
      return taken;
    },
    stop: () => observer.disconnect(),
  };
}

const runs: RunCount = { memo: 0, effect: 0 };

export function takeRuns(): RunCount {
  const taken = { ...runs };
  runs.memo = runs.effect = 0;
  return taken;
}

type Primitive = (fn: (prev: unknown) => unknown, ...rest: unknown[]) => unknown;

const counted =
  (kind: keyof RunCount, primitive: Primitive): Primitive =>
  (fn, ...rest) =>
    primitive(
      (prev) => {
        runs[kind]++;
        return fn(prev);
      },
      ...rest,
    );

const lists: ListChurn[] = [];

type Row = (...args: unknown[]) => unknown;
type ForProps = { each: unknown; keyed?: unknown; fallback?: unknown; children: Row };

function countingFor(For: (props: ForProps) => unknown, onCleanup: (fn: () => void) => void, proxy: symbol) {
  return (props: ForProps) => {
    const list: ListChurn = { store: false, length: 0, first: undefined, made: 0, disposed: 0 };
    lists.push(list);
    const forwarded: ForProps = {
      get each() {
        const each = props.each as unknown[] | undefined;
        list.store = !!each && proxy in each;
        list.length = each?.length ?? 0;
        list.first = each?.[0];
        return each;
      },
      get keyed() {
        return props.keyed;
      },
      get children() {
        const row = props.children;
        const counted: Row = (...args) => {
          list.made++;
          onCleanup(() => list.disposed++);
          return row(...args);
        };
        return row.length > 1 ? (a: unknown, b: unknown) => counted(a, b) : (a: unknown) => counted(a);
      },
    };
    if ("fallback" in props)
      Object.defineProperty(forwarded, "fallback", { get: () => props.fallback, enumerable: true });
    return For(forwarded);
  };
}

// For `vi.mock("solid-js", ...)`. Only calls that cross the module boundary are
// seen, so the memos inside Show, For and Switch are not counted.
export function countingSolid<T extends object>(solid: T): T {
  const real = solid as unknown as Record<"createMemo" | "createEffect" | "createRenderEffect", Primitive> & {
    For: (props: ForProps) => unknown;
    onCleanup: (fn: () => void) => void;
    $PROXY: symbol;
  };
  return {
    ...solid,
    For: countingFor(real.For, real.onCleanup, real.$PROXY),
    createMemo: counted("memo", real.createMemo),
    createEffect: counted("effect", real.createEffect),
    createRenderEffect: counted("effect", real.createRenderEffect),
  };
}
