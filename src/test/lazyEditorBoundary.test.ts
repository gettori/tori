// The lazy edge around CodeMirror (plan phase 7 verify): CodeEditor and the
// grammars load on first file open through Editor.tsx's lazy() edges. This
// walks the eager static-import graph from the entry and names any offender.
import { describe, it, expect } from "vitest";

// Vite's own glob rather than `node:fs`, the way `boundary.test.ts` does it,
// so no `@types/node` is needed. Keys are relative to this file: `../index.tsx`.
const SOURCES = import.meta.glob<string>("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ENTRY = "../index.tsx";

// The CM core trio (view/state/merge) is deliberately allowed: the conflict
// surface has always pulled it eagerly. The split's payload is CodeEditor plus
// the grammars, so the fence sits on @lezer and the lazy-only modules. Shiki
// sits behind the same fence: the chat's highlighter reaches it only through
// highlight.ts's dynamic import. So does mermaid, which Diagram.tsx fetches on
// first sight of a diagram and never before.
const FORBIDDEN_SPECIFIER =
  /^(@codemirror\/(?!view$|state$|merge$)|codemirror$|@lezer\/|shiki$|shiki\/|@shikijs\/|mermaid$|mermaid\/)/;
const FORBIDDEN_MODULES = [
  "../panels/Editor/CodeEditor",
  "../panels/Editor/SearchResultsBuffer",
  "../panels/Editor/lspClient",
  "../panels/Editor/diffGutter",
  "../panels/Chat/shikiEngine",
  "../utils/mermaidEngine",
];

// Static edges only: `import ... from "x"`, `import "x"`, `export ... from "x"`.
// A dynamic `import("x")` is the lazy edge itself and must not count, and a
// type-only import erases at build time.
const STATIC_EDGE = /(?:^|\n)\s*((?:import|export)\s[^;'"]*?)["']([^"']+)["']/g;

/** Join a module key ("../panels/Editor/Editor.tsx") with a relative
 *  specifier ("../../utils/events"), staying in the glob's key space. */
function joinKey(fromKey: string, spec: string): string {
  const parts = fromKey.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function resolveLocal(fromKey: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = joinKey(fromKey, spec);
  for (const k of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (k in SOURCES) return k;
  }
  // A css/svg/other asset import: not a code edge.
  return null;
}

describe("the CodeMirror lazy boundary", () => {
  it("keeps every eager module free of CodeMirror and the lazy-only editor modules", () => {
    expect(ENTRY in SOURCES).toBe(true);
    const seen = new Set<string>([ENTRY]);
    const queue = [ENTRY];
    const offenses: string[] = [];
    while (queue.length) {
      const key = queue.pop()!;
      for (const m of SOURCES[key].matchAll(STATIC_EDGE)) {
        if (/^(?:import|export)\s+type\b/.test(m[1].trim())) continue;
        const spec = m[2];
        if (FORBIDDEN_SPECIFIER.test(spec)) offenses.push(`${key} -> ${spec}`);
        const local = resolveLocal(key, spec);
        if (!local) continue;
        if (FORBIDDEN_MODULES.includes(local.replace(/\.(ts|tsx)$/, ""))) {
          offenses.push(`${key} -> ${spec}`);
        } else if (!seen.has(local)) {
          seen.add(local);
          queue.push(local);
        }
      }
    }
    // The graph must actually be a graph: an entry that resolved nothing would
    // pass vacuously and say nothing about the boundary.
    expect(seen.size).toBeGreaterThan(50);
    expect(offenses).toEqual([]);
  });
});
