import { appChain, inLibrary, shallowProps, typeName, type Components } from "./components";

export type Fiber = {
  tag?: number;
  type?: unknown;
  name?: string;
  return?: Fiber | null;
  memoizedProps?: Record<string, unknown> | null;
  _debugOwner?: Fiber | null;
  owner?: Fiber | null;
  _debugStack?: { stack?: string } | null;
  _debugSource?: { fileName?: string } | null;
};

const FiberTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  ForwardRef: 11,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
} as const;
const COMPOSITE = new Set<number>(Object.values(FiberTag));

export function fiberOf(node: object): Fiber | null {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as Record<string, Fiber>)[key] ?? null;
    }
  }
  return null;
}

// A server component's owner is plain info with a name and no tag.
const label = (fiber: Fiber) => (fiber.tag === undefined ? (fiber.name ?? "") : typeName(fiber.type));

const ownerOf = (fiber: Fiber) => fiber._debugOwner ?? fiber.owner ?? null;

function ownerInLibrary(child: Fiber): boolean | undefined {
  const file = child._debugSource?.fileName;
  if (file) return inLibrary(file);
  const lines = child._debugStack?.stack?.split("\n").filter((l) => l.trim().startsWith("at "));
  if (!lines?.length) return undefined;
  const runtime = lines.findIndex((l) => /jsx|createElement/i.test(l.trim().split(" ")[1] ?? ""));
  const frame = lines[runtime + 1];
  return frame === undefined ? undefined : inLibrary(frame);
}

type FiberStep = { fiber: Fiber; library: boolean | undefined };

function ownerSteps(host: Fiber): FiberStep[] {
  const steps: FiberStep[] = [];
  let child = host;
  for (let at = ownerOf(host); at; child = at, at = ownerOf(at))
    steps.push({ fiber: at, library: ownerInLibrary(child) });
  return steps;
}

function compositeSteps(host: Fiber): FiberStep[] {
  const steps: FiberStep[] = [];
  for (let at = host.return; at; at = at.return) {
    if (at.tag !== undefined && COMPOSITE.has(at.tag)) steps.push({ fiber: at, library: undefined });
  }
  return steps;
}

export function reactComponents(host: Fiber, sensitive: boolean): Components | null {
  const steps = ownerOf(host) ? ownerSteps(host) : compositeSteps(host);
  const chain = appChain(steps.map(({ fiber, library }) => ({ name: label(fiber), library })));
  if (!chain) return null;
  const props = steps[0].fiber.memoizedProps;
  return { chain, props: props ? shallowProps(props, sensitive) : null, source: null };
}
