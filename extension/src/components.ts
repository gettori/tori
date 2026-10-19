export type Components = { chain: string[]; props: Record<string, string> | null; source: string | null };

export type Step = { name: string; library: boolean | undefined };

const CHAIN_CAP = 6;
const PROP_CAP = 20;
const VALUE_CAP = 200;
const HIDDEN_PROPS = new Set(["children", "ref", "data-insp-path"]);
const SECRET = /pass|secret|token|key/i;

export function typeName(type: unknown): string {
  if (typeof type === "function") return (type as { displayName?: string }).displayName || type.name || "";
  if (type && typeof type === "object") {
    const t = type as { displayName?: string; render?: unknown; type?: unknown };
    return t.displayName || typeName(t.render) || typeName(t.type);
  }
  return "";
}

export const inLibrary = (file: string) => file.includes("node_modules");

function preview(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP)}...` : value);
  if (value === null || value === undefined || typeof value !== "object") {
    return typeof value === "function" ? "fn" : String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  const element = value as { $$typeof?: unknown; type?: unknown };
  if (typeof element.$$typeof === "symbol") return `<${typeName(element.type) || String(element.type)}>`;
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

const libraryInternal = (steps: Step[], i: number) => steps[i].library === true && steps[i + 1]?.library !== false;

export function appChain(steps: Step[]): string[] | null {
  const chain: string[] = [];
  steps.forEach(({ name }, i) => {
    if (!name || /Context|Provider|Consumer/.test(name) || chain[chain.length - 1] === name) return;
    if (libraryInternal(steps, i)) return;
    chain.push(name);
  });
  const kept = chain.slice(0, CHAIN_CAP);
  return kept.length && !minified(kept) ? kept : null;
}
