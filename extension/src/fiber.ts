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

export type Components = { chain: string[]; props: Record<string, string> | null };

const FiberTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  ForwardRef: 11,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
} as const;
const COMPOSITE = new Set<number>(Object.values(FiberTag));
const CHAIN_CAP = 6;
const PROP_CAP = 20;
const VALUE_CAP = 200;
const HIDDEN_PROPS = new Set(["children", "ref", "data-insp-path"]);
const SECRET = /pass|secret|token|key/i;

export function fiberOf(node: object): Fiber | null {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as Record<string, Fiber>)[key] ?? null;
    }
  }
  return null;
}

function nameOf(type: unknown): string {
  if (typeof type === "function") return (type as { displayName?: string }).displayName || type.name || "";
  if (type && typeof type === "object") {
    const t = type as { displayName?: string; render?: unknown; type?: unknown };
    return t.displayName || nameOf(t.render) || nameOf(t.type);
  }
  return "";
}

// A server component's owner is plain info with a name and no tag.
const label = (fiber: Fiber) => (fiber.tag === undefined ? (fiber.name ?? "") : nameOf(fiber.type));

const ownerOf = (fiber: Fiber) => fiber._debugOwner ?? fiber.owner ?? null;

function ownerInLibrary(child: Fiber): boolean | undefined {
  const file = child._debugSource?.fileName;
  if (file) return file.includes("node_modules");
  const lines = child._debugStack?.stack?.split("\n").filter((l) => l.trim().startsWith("at "));
  if (!lines?.length) return undefined;
  const runtime = lines.findIndex((l) => /jsx|createElement/i.test(l.trim().split(" ")[1] ?? ""));
  const frame = lines[runtime + 1];
  return frame === undefined ? undefined : frame.includes("node_modules");
}

function preview(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP)}...` : value);
  if (value === null || value === undefined || typeof value !== "object") {
    return typeof value === "function" ? "fn" : String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  const element = value as { $$typeof?: unknown; type?: unknown };
  if (typeof element.$$typeof === "symbol") return `<${nameOf(element.type) || String(element.type)}>`;
  return `{${Object.keys(value).slice(0, 5).join(", ")}${Object.keys(value).length > 5 ? ", ..." : ""}}`;
}

export function shallowProps(props: Record<string, unknown>, sensitive: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(props)) {
    if (HIDDEN_PROPS.has(name)) continue;
    if (Object.keys(out).length >= PROP_CAP) break;
    const hide = typeof value !== "function" && (sensitive || SECRET.test(name));
    out[name] = hide ? "[redacted]" : preview(value);
  }
  return out;
}

const minified = (chain: string[]) => chain.every((name) => name.length <= 2);

type Step = { fiber: Fiber; library: boolean | undefined };

function ownerSteps(host: Fiber): Step[] {
  const steps: Step[] = [];
  let child = host;
  for (let at = ownerOf(host); at; child = at, at = ownerOf(at))
    steps.push({ fiber: at, library: ownerInLibrary(child) });
  return steps;
}

function compositeSteps(host: Fiber): Step[] {
  const steps: Step[] = [];
  for (let at = host.return; at; at = at.return) {
    if (at.tag !== undefined && COMPOSITE.has(at.tag)) steps.push({ fiber: at, library: undefined });
  }
  return steps;
}

// A library component stays only where the app's own code used it, so a library
// Button shows but not its insides, nor the framework's router above the page.
function appChain(steps: Step[]): string[] {
  const chain: string[] = [];
  steps.forEach(({ fiber, library }, i) => {
    const name = label(fiber);
    if (!name || /Context|Provider|Consumer/.test(name) || chain[chain.length - 1] === name) return;
    if (library === true && steps[i + 1]?.library !== false) return;
    chain.push(name);
  });
  return chain.slice(0, CHAIN_CAP);
}

export function componentsOf(host: Fiber, sensitive: boolean): Components | null {
  const steps = ownerOf(host) ? ownerSteps(host) : compositeSteps(host);
  if (!steps.length) return null;
  const chain = appChain(steps);
  if (!chain.length || minified(chain)) return null;
  const props = steps[0].fiber.memoizedProps;
  return { chain, props: props ? shallowProps(props, sensitive) : null };
}
