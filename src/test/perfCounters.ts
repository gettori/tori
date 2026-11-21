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

export interface RenderCost {
  mutations: number;
  memos: number;
  effects: number;
}

// Mount work deferred by a timer lands inside a shorter window and moves the
// counts: chat read 34 mutations at 100ms and 4 at 30, 500 and 1500.
const SETTLE_MS = 500;
export const settled = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

export async function renderCost(root: Node, act: () => unknown): Promise<RenderCost> {
  await settled();
  const counter = countMutations(root);
  takeRuns();
  await act();
  await settled();
  const { added, removed, attributes, text } = counter.take();
  const { memo, effect } = takeRuns();
  counter.stop();
  return { mutations: added + removed + attributes + text, memos: memo, effects: effect };
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

// For `vi.mock("solid-js", ...)`. Only calls that cross the module boundary are
// seen, so the memos inside Show, For and Switch are not counted.
export function countingSolid<T extends object>(solid: T): T {
  const real = solid as unknown as Record<"createMemo" | "createEffect" | "createRenderEffect", Primitive>;
  return {
    ...solid,
    createMemo: counted("memo", real.createMemo),
    createEffect: counted("effect", real.createEffect),
    createRenderEffect: counted("effect", real.createRenderEffect),
  };
}
