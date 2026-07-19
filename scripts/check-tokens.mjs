#!/usr/bin/env node
// Guard the token layer. Two checks:
//
//   1. No color literal may live in a component (they render identically in
//      both themes, which is how a "light mode" ships half-dark).
//   2. tokens.css must be structurally two-theme: every semantic token dark
//      defines needs a light value, light needs its own syntax ramp, and both
//      need the full 16-slot terminal ANSI ramp.
//
// Check 2 lives here rather than in vitest because vitest stubs CSS imports to
// the empty string, and this script already reads files and already gates
// `pnpm test`.
//
// Light mode is only as complete as the CSS is token-driven. A single stray
// `#2ea043` renders identically in both themes, which is exactly the bug that
// makes a "light mode" ship half-dark - and it is invisible in review because
// dark looks correct. So this fails the build rather than relying on care.
//
// Scans src/ for hex colors, rgb()/rgba()/hsl()/hsla(), and CSS named colors,
// and reports anything outside tokens.css or the allowlist below.
//
// Run: node scripts/check-tokens.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Every entry needs a reason. "It was easier" is not one: if a color belongs to
// the UI's palette it belongs in tokens.css, and the only legitimate exemptions
// are values that are data rather than styling.
const ALLOWLIST = new Map([
  ["src/styles/tokens.css", "the token layer itself: the one place literals are defined"],
  ["src/seti/mapping.ts", "Seti file-icon palette: data from the upstream icon theme, keyed by file type, not UI chrome"],
  ["src/theme/vscodeMap.ts", "per-token fallbacks mirroring the VS Code Dark+ defaults, used when an imported theme omits a key"],
  ["src/theme/themes/dark-plus.json", "a VS Code theme file: colors are its content"],
  ["src/theme/themes/light-plus.json", "a VS Code theme file: colors are its content"],
  ["src/theme/theme.test.ts", "test fixtures asserting the distiller maps specific colors"],
  ["src/dev/Styleguide.tsx", "the token gallery: it renders swatch names, and its labels are the token names themselves"],
]);

const NAMED = [
  "white", "black", "red", "green", "blue", "yellow", "orange", "purple", "gray",
  "grey", "cyan", "magenta", "pink", "brown", "silver", "gold", "navy", "teal",
  "olive", "maroon", "lime", "aqua", "fuchsia", "crimson", "tomato", "salmon",
  "khaki", "violet", "indigo", "beige", "ivory", "coral", "plum", "orchid",
  "wheat", "azure", "lavender",
];

// `transparent` and `currentColor` are intentionally not flagged: they are
// keywords that adapt to context rather than fixed colors.
const PATTERNS = [
  [/#[0-9a-fA-F]{3,8}\b/g, "hex color"],
  [/\brgba?\(/g, "rgb()/rgba()"],
  [/\bhsla?\(/g, "hsl()/hsla()"],
  // A trailing `:` means the word is a key/property name, not a value -
  // xterm's ITheme has `black:`, `red:`, `cyan:` fields holding var() reads.
  // In CSS a named color is always a value, so it is never followed by `:`.
  [new RegExp(`(?<![\\w-])(?:${NAMED.join("|")})(?![\\w-])(?!\\s*:)`, "g"), "CSS named color"],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") walk(path, out);
    } else if (/\.(css|tsx?|json)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

// Comments explain colors constantly ("the gold brand", "#fff on a fill"), and
// flagging prose would train everyone to ignore this check.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWLIST.has(rel)) continue;
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    for (const [pattern, label] of PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) violations.push({ rel, line: i + 1, label, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(`${violations.length} color literal(s) outside the token layer:\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  (${v.label})`);
    console.error(`    ${v.text}`);
  }
  console.error("\nAdd a semantic token in src/styles/tokens.css for BOTH themes and use var(--token).");
  console.error("If the value is genuinely not UI styling, add it to ALLOWLIST in this script with a reason.");
  process.exit(1);
}

// ---- Check 2: tokens.css is structurally two-theme ----
//
// A token defined for dark alone does not fail loudly. It silently keeps its
// dark value in light mode, which is exactly how a light UI ends up with dark
// remnants - so the absence has to be an error, not a thing to notice.

const TOKENS_CSS = readFileSync(join(SRC, "styles/tokens.css"), "utf8");
const DARK_BLOCK = "---- Semantic tokens, dark";
const LIGHT_BLOCK = "---- Semantic tokens, light";

/** Custom-property names declared in the brace-balanced block after `marker`. */
function declaredIn(marker) {
  const start = TOKENS_CSS.indexOf(marker);
  if (start < 0) {
    console.error(`tokens.css no longer contains the marker "${marker}".`);
    console.error("This script locates the theme blocks by that comment; restore it or update the marker here.");
    process.exit(1);
  }
  const open = TOKENS_CSS.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < TOKENS_CSS.length; i++) {
    if (TOKENS_CSS[i] === "{") depth++;
    else if (TOKENS_CSS[i] === "}" && --depth === 0) break;
  }
  const body = TOKENS_CSS.slice(open + 1, i);
  return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
}

const darkTokens = declaredIn(DARK_BLOCK);
const lightTokens = declaredIn(LIGHT_BLOCK);
const structural = [];

for (const token of darkTokens) {
  if (!lightTokens.has(token)) structural.push(`${token} has a dark value but no light one`);
}

// The :root defaults are Dark+; without a light override, a first boot with no
// cached theme paints dark-theme syntax onto a white editor.
for (const category of ["keyword", "string", "comment", "number", "function", "type", "variable"]) {
  if (!lightTokens.has(`--syn-${category}`)) {
    structural.push(`--syn-${category} has no light override (light would inherit the Dark+ default)`);
  }
}

const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];
for (const [themeName, tokens] of [["dark", darkTokens], ["light", lightTokens]]) {
  for (const slot of ANSI_SLOTS) {
    if (!tokens.has(`--term-${slot}`)) {
      structural.push(`--term-${slot} is missing from the ${themeName} ANSI ramp`);
    }
  }
}

if (structural.length > 0) {
  console.error(`${structural.length} token-layer gap(s) in src/styles/tokens.css:\n`);
  for (const problem of structural) console.error(`  ${problem}`);
  console.error("\nEvery semantic token needs a value in BOTH theme blocks, or light silently inherits dark.");
  process.exit(1);
}

console.log(
  `Token check passed: no color literals outside tokens.css (${ALLOWLIST.size} allowlisted files), ` +
    `and all ${darkTokens.size} dark tokens have light values.`,
);
