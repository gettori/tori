#!/usr/bin/env node
// Guard the token layer. Five checks:
//
//   1. No color literal may live in a component (they render identically in
//      both themes, which is how a "light mode" ships half-dark).
//   2. Every bundled palette produces every declared role, and the generated
//      region of tokens.css agrees with what the generator emits today.
//   3. Every var(--x) in src/ resolves to a role, a --sway-* primitive, or a
//      locally declared property.
//   4. Every name TerminalView.termColors() reads is a declared role.
//   5. Every name the styleguide galleries list is a declared role.
//
// All of it lives here rather than in vitest because vitest stubs CSS imports to
// the empty string and jsdom does not resolve var(), so nothing in the test
// stack can see the token layer at all. This script reads files directly and
// already gates `pnpm test`.
//
// Checks 4 and 5 exist because those names are TypeScript string literals, so
// no CSS tooling and not even check 3 can see them; a stale one degrades
// silently rather than failing.
//
// Light mode is only as complete as the CSS is token-driven. A single stray
// `#2ea043` renders identically in both themes, which is exactly the bug that
// makes a "light mode" ship half-dark - and it is invisible in review because
// dark looks correct. So this fails the build rather than relying on care.
//
// Check 1 scans src/ for hex colors, rgb()/rgba()/hsl()/hsla(), and CSS named
// colors, and reports anything outside tokens.css or the allowlist below.
//
// Run: node scripts/check-tokens.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, ROLE_BY_CSS_VAR, buildRoles } from "../src/theme/roles.ts";
import { validatePalette } from "../src/theme/schema.ts";
import { tokensCss } from "./gen-tokens.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Every entry needs a reason. "It was easier" is not one: if a color belongs to
// the UI's palette it belongs in tokens.css, and the only legitimate exemptions
// are values that are data rather than styling.
const ALLOWLIST = new Map([
  ["src/styles/tokens.css", "the token layer itself: the one place literals are defined"],
  ["src/seti/mapping.ts", "Seti file-icon palette: data from the upstream icon theme, keyed by file type, not UI chrome"],
  ["src/theme/roles.test.ts", "test fixtures asserting the derivation helpers produce specific colors, and that the generator reproduces the frozen baseline"],
  ["src/theme/registry.test.ts", "test fixtures asserting a theme switch repaints specific role values"],
  ["src/dev/Styleguide.tsx", "the token gallery: it renders swatch names, and its labels are the token names themselves"],
]);

// Directory prefixes, for families of files where every member is exempt for the
// same reason. A prefix rather than one entry per file: a counted list of paths
// goes stale the moment a theme is added, and the staleness is silent.
const ALLOWLIST_PREFIXES = new Map([
  ["src/theme/palettes/", "theme palettes: flat hex primitives ARE the file's content, and roles.ts derives every semantic role from them"],
  ["src/theme/__baseline__/", "the frozen pre-migration token map, plus the rename table that translates it: together they prove the Phase 4 rename was purely nominal, and both are keyed by the old names by construction"],
]);

/** Whether `rel` is exempt from check 1, by exact path or by directory prefix. */
function isAllowlisted(rel) {
  if (ALLOWLIST.has(rel)) return true;
  for (const prefix of ALLOWLIST_PREFIXES.keys()) {
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

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
  // `rgba(${...}` is a format string, not a colour: it is how the derivation
  // helpers in theme/roles.ts emit a wash whose channels came from the palette.
  // A literal colour never interpolates.
  [/\brgba?\((?!\$\{)/g, "rgb()/rgba()"],
  [/\bhsla?\((?!\$\{)/g, "hsl()/hsla()"],
  // A trailing `:` means the word is a key/property name, not a value -
  // xterm's ITheme has `black:`, `red:`, `cyan:` fields holding var() reads.
  // In CSS a named color is always a value, so it is never followed by `:`.
  // A leading `.` means it is a member of something rather than a value: the
  // role ids in theme/roles.ts are dotted (`ansi.black`, `ansi.green`), and a
  // CSS value never has a dot immediately before the colour name.
  [new RegExp(`(?<![\\w.-])(?:${NAMED.join("|")})(?![\\w-])(?!\\s*:)`, "g"), "CSS named color"],
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
    // A block comment collapses to its own newlines rather than to "", so every
    // line after it keeps its number. Deleting them outright shifts every
    // subsequent report, and a guard that names the wrong line is one people
    // learn to distrust.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// An allowlist entry pointing at a file that no longer exists is silent rot: it
// reads as a considered exemption while exempting nothing, and it is exactly
// what survives a deletion nobody swept up after. Fail on it, so removing a
// file forces its reason to go with it.
const stale = [
  ...[...ALLOWLIST.keys()].filter((rel) => !existsSync(join(ROOT, rel))),
  ...[...ALLOWLIST_PREFIXES.keys()].filter((rel) => !existsSync(join(ROOT, rel))),
];
if (stale.length > 0) {
  console.error(`${stale.length} allowlist entr(ies) in this script name a path that no longer exists:\n`);
  for (const rel of stale) console.error(`  ${rel}`);
  console.error("\nDelete the entry along with the file it exempted.");
  process.exit(1);
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (isAllowlisted(rel)) continue;
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

// ---- Check 2: every palette produces every role, and tokens.css agrees ----
//
// This used to ask whether each token declared for dark also had a light value.
// The generator answers that upstream now: one palette in, one key set out, so
// a light-only gap is no longer expressible. What IS still expressible is a
// palette missing a primitive, a derivation that yields nothing, and a hand-edit
// to the generated region of tokens.css - which would put the boot fallback and
// the runtime theme at odds, visible only as a flash of the wrong colour.

const PALETTE_DIR = join(SRC, "theme/palettes");
const palettes = readdirSync(PALETTE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(PALETTE_DIR, f), "utf8"))]);

const structural = [];
if (palettes.length === 0) structural.push(`no palettes found in ${relative(ROOT, PALETTE_DIR)}`);

for (const [id, palette] of palettes) {
  for (const problem of validatePalette(palette)) structural.push(`${id}: ${problem}`);

  let values;
  try {
    values = buildRoles(palette);
  } catch (e) {
    structural.push(`${id}: roles.ts threw building the role set: ${e.message}`);
    continue;
  }
  for (const role of ROLES) {
    const value = values[role.cssVar];
    if (!value) structural.push(`${id}: role ${role.id} (${role.cssVar}) has no value`);
    // A derivation reading a key the palette lacks produces a *string* holding
    // "undefined" or "NaN" rather than throwing, which CSS then silently drops.
    else if (/undefined|NaN|var\(/.test(value)) {
      structural.push(`${id}: role ${role.id} (${role.cssVar}) resolved to "${value}"`);
    }
  }
  const undeclared = Object.keys(values).filter((k) => !ROLE_BY_CSS_VAR.has(k));
  if (undeclared.length > 0) {
    structural.push(`${id}: emits ${undeclared.length} key(s) absent from ROLES: ${undeclared.join(", ")}`);
  }
}

try {
  const { current, next } = tokensCss();
  if (current !== next) {
    structural.push(
      "the generated region of src/styles/tokens.css does not match the palettes (run: node scripts/gen-tokens.mjs)",
    );
  }
} catch (e) {
  structural.push(e.message);
}

if (structural.length > 0) {
  console.error(`${structural.length} problem(s) in the palette-to-role layer:\n`);
  for (const problem of structural) console.error(`  ${problem}`);
  console.error("\nEvery bundled palette must produce a concrete value for every role in ROLES,");
  console.error("and the boot fallback in tokens.css must be what the generator would write.");
  process.exit(1);
}

// ---- Check 3: every var(--x) in src/ resolves to something declared ----
//
// A var() naming a property nobody declares does not fail, warn, or fall back:
// the declaration is simply dropped and the element renders with whatever it
// inherited. That is how `var(--hover-bg)` sat in ReviewPanel unnoticed. The
// name is only meaningful if something declares it, so an unresolvable one is
// an error rather than a thing to spot in review.

/** Custom properties declared in `text`, by CSS declaration, by an inline style
 *  object key, or by a runtime setProperty call. */
function declarationsIn(text) {
  const names = new Set();
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  for (const m of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) names.add(m[1]);
  return names;
}

// var() names built at runtime, which no static scan can resolve. Named one by
// one rather than skipping every interpolated var(), so a new dynamic token has
// to be declared here instead of quietly joining the set.
const DYNAMIC_VARS = new Map([
  [
    "src/dev/Styleguide.tsx",
    {
      prefixes: ["--shadow-", "--sway-text-", "--sway-space-", "--sway-radius-"],
      reason: "the gallery renders each scale over its own list of stop names, e.g. var(--shadow-${s})",
    },
  ],
]);

// Comments are stripped for the same reason check 1 strips them: prose talks
// about tokens constantly ("superseded by var(--hover)"), and a comment naming a
// token that has since been removed would fail the build for documenting
// history accurately.
const scanned = walk(SRC).filter((f) => /\.(css|tsx?)$/.test(f));
const sources = new Map(scanned.map((f) => [relative(ROOT, f), stripComments(readFileSync(f, "utf8"))]));

// Global scope: the token layer, every role the generator emits, and anything a
// module writes onto an element at runtime (settingsStore's --ui-*, the
// resolver's roles). A property declared in one CSS module is NOT global - it
// only reaches descendants of that rule - so those stay per-file below.
const globalNames = new Set(ROLES.map((r) => r.cssVar));
for (const name of declarationsIn(sources.get("src/styles/tokens.css") ?? "")) globalNames.add(name);
for (const [rel, text] of sources) {
  if (!rel.endsWith(".css")) for (const m of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) globalNames.add(m[1]);
}

// tokens.css is scanned like every other file, not skipped. It is the boot
// fallback, so a var() naming nothing there paints wrong *before* any script
// runs and nothing downstream can correct it. Its own declarations are already
// in globalNames, so its internal references resolve against themselves.
const unresolved = [];
for (const [rel, text] of sources) {
  const local = declarationsIn(text);
  const dynamic = DYNAMIC_VARS.get(rel);
  const lines = text.split("\n");
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(.?)/g)) {
    const [name, next] = [m[1], m[2]];
    const line = text.slice(0, m.index).split("\n").length;
    // An interpolation immediately after the name means the real name is built
    // at runtime and `name` is only its literal prefix.
    if (next === "$" && text[m.index + m[0].length] === "{") {
      if (dynamic?.prefixes.some((p) => name.startsWith(p) || p.startsWith(name))) continue;
      unresolved.push({ rel, line, name: `${name}\${...}`, text: lines[line - 1].trim() });
      continue;
    }
    // `var(--x, <fallback>)` handles its own absence by construction: the
    // fallback IS the declaration. That is how an optional per-call-site knob
    // like --btn-icon-size is meant to read, so requiring a declaration would
    // force a dummy one and defeat the point.
    if (next === ",") continue;
    if (globalNames.has(name) || local.has(name)) continue;
    unresolved.push({ rel, line, name, text: lines[line - 1].trim() });
  }
}

if (unresolved.length > 0) {
  console.error(`${unresolved.length} var() reference(s) that resolve to nothing:\n`);
  for (const u of unresolved) {
    console.error(`  ${u.rel}:${u.line}  ${u.name}`);
    console.error(`    ${u.text}`);
  }
  console.error("\nA var() naming an undeclared property is dropped silently and the element inherits instead.");
  console.error("Use a role cssVar from src/theme/roles.ts, a --sway-* primitive, or declare it locally.");
  console.error("A name built at runtime needs an entry in DYNAMIC_VARS in this script, with a reason.");
  process.exit(1);
}

// ---- Check 4: the terminal reads names that exist ----
//
// TerminalView pulls its 20 colours through getComputedStyle, as TypeScript
// string literals. No CSS tooling can see them, check 3 cannot either, and a
// missed name yields `undefined` - which xterm takes as "use my own default",
// so the terminal quietly stops following the theme instead of breaking.

const TERMINAL_VIEW = "src/panels/Terminal/TerminalView.tsx";
const termSource = sources.get(TERMINAL_VIEW);
const termBody = termSource && /function termColors\(\)\s*\{[\s\S]*?\n\}/.exec(termSource);
const termNames = termBody ? [...termBody[0].matchAll(/\bv\(\s*"(--[\w-]+)"\s*\)/g)].map((m) => m[1]) : [];

const termProblems = [];
if (!termBody) {
  termProblems.push(`could not find termColors() in ${TERMINAL_VIEW}; this check locates it by that name`);
} else if (termNames.length === 0) {
  termProblems.push(`termColors() in ${TERMINAL_VIEW} read no --tokens; the v("--x") form this check scans for changed`);
}
for (const name of termNames) {
  if (!ROLE_BY_CSS_VAR.has(name)) {
    termProblems.push(`termColors() reads ${name}, which is not a role cssVar in src/theme/roles.ts`);
  }
}

if (termProblems.length > 0) {
  console.error(`${termProblems.length} problem(s) in the terminal's theme read:\n`);
  for (const problem of termProblems) console.error(`  ${problem}`);
  console.error("\nEvery name termColors() reads must be a role, or the terminal silently keeps xterm's defaults.");
  process.exit(1);
}

// ---- Check 5: the styleguide's galleries name roles that exist ----
//
// Same shape of blind spot as check 4. The galleries hold their token names as
// string literals and render them as `var(${name})`, so check 3 sees only an
// interpolation and waves them through. A stale name there renders an empty
// chip, which reads as "that role has no colour" rather than as a typo.

const STYLEGUIDE = "src/dev/Styleguide.tsx";
const guideSource = sources.get(STYLEGUIDE);
const GALLERIES = ["BRAND", "SEMANTIC"];
const guideProblems = [];

for (const gallery of GALLERIES) {
  const body = guideSource && new RegExp(`const ${gallery}\\s*(?::[^=]+)?=\\s*\\[[\\s\\S]*?\\n\\]`).exec(guideSource);
  if (!body) {
    guideProblems.push(`could not find const ${gallery} in ${STYLEGUIDE}; this check locates it by that name`);
    continue;
  }
  const names = [...body[0].matchAll(/"(--[\w-]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    guideProblems.push(`${gallery} in ${STYLEGUIDE} lists no --tokens; the literal form this check scans for changed`);
  }
  for (const name of names) {
    if (!ROLE_BY_CSS_VAR.has(name)) {
      guideProblems.push(`${gallery} lists ${name}, which is not a role cssVar in src/theme/roles.ts`);
    }
  }
}

if (guideProblems.length > 0) {
  console.error(`${guideProblems.length} problem(s) in the styleguide galleries:\n`);
  for (const problem of guideProblems) console.error(`  ${problem}`);
  console.error("\nA gallery name that is not a role renders an empty swatch rather than an error.");
  process.exit(1);
}

console.log(
  `Token check passed: no color literals outside tokens.css ` +
    `(${ALLOWLIST.size} allowlisted files, ${ALLOWLIST_PREFIXES.size} allowlisted directories), ` +
    `${palettes.length} palettes each producing all ${ROLES.length} roles, ` +
    `every var() in src/ resolving, all ${termNames.length} terminal reads mapped, ` +
    `and every styleguide gallery name a declared role.`,
);
