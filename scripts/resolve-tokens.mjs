#!/usr/bin/env node
// Resolve the token layer to a flat { cssVar: concreteValue } map per theme.
//
// This exists because nothing else can do it. The theme blocks in tokens.css
// store 35 of their values as `var(--sway-*)` references rather than literals,
// and the 7 `--syn-*` roles are declared in `:root` instead of either theme
// block, so a textual diff of the file cannot answer "what colour is --text in
// light mode". vitest stubs CSS imports to the empty string and jsdom does not
// resolve var(), so a rendering test cannot answer it either.
//
// The output is the ground truth the palette generator is proven against: if
// roles.ts reproduces this map key by key and value by value, the new engine is
// behaviour-preserving. Phase 4 then reuses it to prove the token rename is
// purely nominal.
//
// Run: node scripts/resolve-tokens.mjs [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TOKENS_PATH = join(ROOT, "src/styles/tokens.css");

const DARK_MARKER = "---- Semantic tokens, dark";
const LIGHT_MARKER = "---- Semantic tokens, light";

/** Body of the brace-balanced block that follows `marker`. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`tokens.css no longer contains the marker "${marker}"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  return source.slice(open + 1, i);
}

/** The bare `:root {...}` block, which holds the primitives and the :root-level
 *  --syn-* defaults.
 *
 *  Matched on `:root` immediately followed by `{`, which is narrower than it
 *  looks. A plain indexOf(":root") finds the mention inside the file's header
 *  comment, whose next `{` is `@layer tokens {` - so the balancer swallows the
 *  whole layer, both theme blocks included, and the :root-level --syn-* defaults
 *  silently resolve to light's overrides. The dark theme block opens
 *  `:root,\n:root[data-theme="dark"] {`, so its first `:root` is followed by a
 *  comma and is correctly skipped. */
function rootBlock(source) {
  const at = source.search(/:root\s*\{/);
  if (at < 0) throw new Error("tokens.css has no bare `:root {` primitives block");
  const open = source.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  return source.slice(open + 1, i);
}

/** Custom-property declarations in a block body, as an ordered Map. Comments are
 *  stripped first so a commented-out declaration is not read as live. */
function declarations(body) {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** Substitute `var(--x)` against `vars` until no reference remains. */
function resolveValue(value, vars, seen = new Set()) {
  let out = value;
  for (let pass = 0; pass < 10 && out.includes("var("); pass++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => {
      if (seen.has(name)) throw new Error(`circular var() reference at ${name}`);
      const hit = vars.get(name);
      if (hit === undefined) throw new Error(`var(${name}) is not declared in tokens.css`);
      seen.add(name);
      return hit;
    });
  }
  if (out.includes("var(")) throw new Error(`could not resolve: ${value}`);
  return out.trim();
}

export function resolveTokens(source = readFileSync(TOKENS_PATH, "utf8")) {
  const root = declarations(rootBlock(source));
  const darkRaw = declarations(blockAfter(source, DARK_MARKER));
  const lightRaw = declarations(blockAfter(source, LIGHT_MARKER));

  // The 7 --syn-* live in :root, not in the dark block: dark inherits them, and
  // light overrides them in its own block. Fold them into dark so both themes
  // expose the same role set, which is what makes a key-by-key comparison
  // between the two possible at all.
  //
  // Folded UNDER the dark block, not over it: once the theme blocks are
  // generated they declare --syn-* themselves, and a block's own declaration
  // must win over the :root default it shadows.
  const synFromRoot = new Map(
    [...root].filter(([name]) => name.startsWith("--syn-")),
  );
  const dark = new Map([...synFromRoot, ...darkRaw]);
  const light = lightRaw;

  // Primitives resolve against :root; role values may reference them. Keys are
  // emitted sorted so the frozen baseline is stable against declaration-order
  // churn: the file is a value snapshot, and a reordering diff would be noise
  // that hides a real one.
  const resolveMap = (map) => {
    const out = {};
    for (const name of [...map.keys()].sort()) {
      out[name] = resolveValue(map.get(name), new Map([...root, ...map]), new Set());
    }
    return out;
  };

  return { dark: resolveMap(dark), light: resolveMap(light) };
}

// ---- CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resolved = resolveTokens();
  const darkKeys = Object.keys(resolved.dark);
  const lightKeys = Object.keys(resolved.light);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(resolved, null, 2));
  } else {
    const problems = [];
    for (const [theme, map] of [["dark", resolved.dark], ["light", resolved.light]]) {
      for (const [name, value] of Object.entries(map)) {
        if (value.includes("var(")) problems.push(`${theme} ${name} still contains var(): ${value}`);
      }
    }
    for (const name of darkKeys) {
      if (!(name in resolved.light)) problems.push(`${name} is in dark but not light`);
    }
    for (const name of lightKeys) {
      if (!(name in resolved.dark)) problems.push(`${name} is in light but not dark`);
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(
      `Resolved ${darkKeys.length} dark + ${lightKeys.length} light = ` +
        `${darkKeys.length + lightKeys.length} entries, no unresolved var().`,
    );
  }
}
