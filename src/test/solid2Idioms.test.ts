import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";
import { scan } from "../../scripts/solid2-idioms.mjs";
import { ENFORCED, LEDGER, type IdiomClass } from "./solid2Ledger";

const SOURCES = Object.entries(
  import.meta.glob<string>(
    ["../**/*.{ts,tsx}", "../../mobile/src/**/*.{ts,tsx}", "../../extension/src/**/*.{ts,tsx}"],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ),
)
  .filter(([path]) => !path.endsWith(".d.ts"))
  .map(([path, source]) => [path.replace(/^\.\.\/\.\.\//, "").replace(/^\.\.\//, "src/"), source] as const);

// Parsed at collection, which has no timeout, since it covers every source file.
const HITS = SOURCES.flatMap(([file, source]) => scan(ts, file, source));

function unledgered(idiom: IdiomClass): string[] {
  const found = new Map<string, number>();
  for (const hit of HITS) if (hit.class === idiom) found.set(hit.file, (found.get(hit.file) ?? 0) + 1);
  const out: string[] = [];
  const ledger = LEDGER[idiom] ?? [];
  for (const { file, count, reason } of ledger) {
    if (!reason.trim()) out.push(`${file}: ledger entry has no reason`);
    const actual = found.get(file) ?? 0;
    if (actual !== count) out.push(`${file}: ledger says ${count}, found ${actual}`);
  }
  for (const hit of HITS) {
    if (hit.class === idiom && !ledger.some((entry) => entry.file === hit.file)) {
      out.push(`${hit.file}:${hit.line}: ${idiom}`);
    }
  }
  return out;
}

const classesIn = (source: string, file = "src/fixture.tsx") => scan(ts, file, source).map((hit) => hit.class);

describe("the Solid 2 idiom guard", () => {
  it("scans the app, mobile and the extension", () => {
    const files = SOURCES.map(([file]) => file);
    expect(files).toContain("src/App.tsx");
    expect(files.some((file) => file.startsWith("mobile/src/"))).toBe(true);
    expect(files.some((file) => file.startsWith("extension/src/"))).toBe(true);
  });

  it.each(ENFORCED)("holds %s", (idiom) => {
    expect(unledgered(idiom)).toEqual([]);
  });
});

describe("the boolean attribute classifier", () => {
  it.each([
    ["a string literal", `<p aria-hidden="true" />`],
    ["a string in an expression", `<p aria-hidden={"true"} />`],
    ["a ternary of strings", `<p aria-expanded={open() ? "true" : "false"} />`],
    ["a ternary with undefined", `<p aria-current={on() ? "page" : undefined} />`],
    ["a same name pass through", `<p aria-pressed={props["aria-pressed"]} />`],
    ["a pass through from split props", `<p aria-pressed={local["aria-pressed"]} />`],
    ["a draggable pass through", `<p draggable={props.draggable} />`],
    ["a spreadable object key holding a string", `const attrs = { draggable: "true" };`],
    ["a free text attribute", `<p aria-label={label()} />`],
    ["a numeric attribute", `<p aria-valuenow={value()} />`],
  ])("passes %s", (_, source) => {
    expect(classesIn(source)).toEqual([]);
  });

  it.each([
    ["a bare accessor", `<p aria-expanded={open()} />`],
    ["a boolean literal", `<p aria-hidden={true} />`],
    ["no value", `<p aria-hidden />`],
    ["a ternary of booleans", `<p aria-expanded={open() ? true : false} />`],
    ["an or undefined", `<p aria-disabled={off() || undefined} />`],
    ["a bare undefined", `<p aria-busy={undefined} />`],
    ["a different prop", `<p aria-pressed={props["aria-checked"]} />`],
    ["a pass through inside a ternary", `<p aria-pressed={on() ? "true" : props["aria-pressed"]} />`],
    ["the same name on a data object", `<p draggable={row.draggable} />`],
    ["draggable", `<p draggable={can()} />`],
    ["spellcheck", `<p spellcheck={false} />`],
    ["an object key", `const attrs = { "aria-expanded": open() };`],
    ["an unquoted object key", `const attrs = { draggable: true };`],
  ])("fails %s", (_, source) => {
    expect(classesIn(source)).toEqual(["boolean-attr"]);
  });
});

describe("the timing classifier", () => {
  it("passes a deferral with a reason above it and a real delay", () => {
    expect(classesIn(`// the layer closes first\nqueueMicrotask(run);\nsetTimeout(run, 200);`)).toEqual([]);
  });

  it.each([
    ["a microtask", `const a = 1;\nqueueMicrotask(run);`],
    ["a zero timeout", `const a = 1;\nsetTimeout(run, 0);`],
    ["a timeout with no delay", `const a = 1;\nsetTimeout(run);`],
    ["a window timeout", `const a = 1;\nwindow.setTimeout(run, 0);`],
  ])("fails %s with no reason", (_, source) => {
    expect(classesIn(source)).toEqual(["timing"]);
  });
});

describe("the camelCase attribute classifier", () => {
  it("passes the lowercase name and a component's own prop", () => {
    expect(classesIn(`<input tabindex={0} readonly />`)).toEqual([]);
    expect(classesIn(`<Field tabIndex={0} />`)).toEqual([]);
  });

  it("fails the camelCase name on an element", () => {
    expect(classesIn(`<input tabIndex={0} />`)).toEqual(["camelcase-attr"]);
  });
});

describe("the root classifier", () => {
  it("passes a module level root and a detached one", () => {
    expect(classesIn(`createRoot(() => {});`)).toEqual([]);
    expect(classesIn(`function view() { return runWithOwner(null, () => createRoot(() => 1)); }`)).toEqual([]);
  });

  it.each([
    ["a bare nested root", `function view() { return createRoot(() => 1); }`],
    ["a root under a real owner", `function view() { return runWithOwner(owner, () => createRoot(() => 1)); }`],
  ])("fails %s", (_, source) => {
    expect(classesIn(source)).toEqual(["nested-root"]);
  });
});

describe("the classes already at zero", () => {
  it.each([
    ["use-directive", `<p use:tip={1} />`],
    ["on-namespace", `<p on:click={run} />`],
    ["lowercase-on", `<p onclick={run} />`],
    ["destructured-props", `function Row({ name }) { return <p>{name}</p>; }`],
  ])("finds %s", (idiom, source) => {
    expect(classesIn(`import "solid-js";\n${source}`)).toEqual([idiom]);
  });

  it("leaves test files out", () => {
    expect(classesIn(`<p aria-expanded={open()} />`, "src/fixture.test.tsx")).toEqual([]);
  });
});
