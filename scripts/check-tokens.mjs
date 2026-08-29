#!/usr/bin/env node
// Guard the token layer. Ten checks:
//
//   1. No color literal may live in a component (they render identically in
//      both themes, which is how a "light mode" ships half-dark).
//   2. Every bundled palette produces every declared role, and the generated
//      region of tokens.css agrees with what the generator emits today.
//   3. Every var(--x) in src/ resolves to a role, a --sway-* primitive, or a
//      locally declared property.
//   4. Every name TerminalView.termColors() reads is a declared role.
//   5. Every token the theme workbench names as a literal resolves.
//   6. Every hue the generated seti mapping emits has a scale.* role.
//   7. Every role semantic tokens paint with has a --syntax-* role.
//   8. The Omnibox palette asks Dialog for its own shorter height bound.
//   8b. Both text cells of a tool call's row can shrink, so one long command
//      cannot scroll the whole transcript sideways.
//   8c. The sidebar's filter row wraps, and the field states the width it
//      needs, which is what puts it beside the tabs or under them.
//   9. The palette's own heading still matches Dialog's title recipe.
//  10. The two blocking surfaces in the chat wear one tier, and nothing else
//      wears it.
//
// All of it lives here rather than in vitest because vitest stubs CSS imports to
// the empty string and jsdom does not resolve var(), so nothing in the test
// stack can see the token layer at all. This script reads files directly and
// already gates `pnpm test`.
//
// Checks 4, 5, 6, and 7 exist because those names are TypeScript string literals
// or are built at runtime, so no CSS tooling and not even check 3 can see them;
// a stale one degrades silently rather than failing.
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
import { SEMANTIC_ROLES } from "../src/utils/semanticTokens.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Every entry needs a reason. "It was easier" is not one: if a color belongs to
// the UI's palette it belongs in tokens.css, and the only legitimate exemptions
// are values that are data rather than styling.
const ALLOWLIST = new Map([
  ["src/styles/tokens.css", "the token layer itself: the one place literals are defined"],
  ["src/theme/roles.test.ts", "test fixtures asserting the derivation helpers produce specific colors, and that the syntax ramp's categories are telling apart"],
  ["src/theme/registry.test.ts", "test fixtures asserting a theme switch repaints specific role values"],
  ["src/theme/contrast.test.ts", "the WCAG reference pairs and the historic misses the gate must keep catching, e.g. Light+'s ANSI green at 2.56 on white"],
  ["src/dev/Styleguide.tsx", "the theme workbench: its swatch labels ARE token names, and its terminal and syntax samples name roles to render them"],
  ["src/utils/spaceTint.ts", "the space swatches: a space's colour is user data stored in sway.toml beside its name and icon, not part of the UI's palette. It must read the same in every theme - a swatch that changed meaning on a theme switch would make the setting meaningless - so it cannot be a role, which is exactly what a role is for"],
  ["src/utils/spaceTint.test.ts", "test fixtures pinning the hex -> channel-triple conversion. A named input and its expected three numbers are the only way to catch a red/blue swap, which every wash in the app would then render in the wrong hue"],
  ["src/panels/Editor/editorFeatures.test.tsx", "buffer contents, not UI styling: the CSS colour-swatch test has to put a colour literal in the document, because a swatch appearing beside one is the whole feature. The literal is the input under test and never reaches a stylesheet"],
]);

// Directory prefixes, for families of files where every member is exempt for the
// same reason. A prefix rather than one entry per file: a counted list of paths
// goes stale the moment a theme is added, and the staleness is silent.
const ALLOWLIST_PREFIXES = new Map([
  ["src/theme/palettes/", "theme palettes: flat hex primitives ARE the file's content, and roles.ts derives every semantic role from them"],
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
  //
  // `rgb(var(--x) / 40%)` is not a colour either: it is a token being composed
  // with an alpha the consumer chooses, which is the whole point of a channel
  // triple role. The channels still come from the palette - there is nothing
  // here for a theme to fail to repaint, which is what this check protects.
  [/\brgba?\((?!\$\{|var\()/g, "rgb()/rgba()"],
  [/\bhsla?\((?!\$\{|var\()/g, "hsl()/hsla()"],
  // A trailing `:` means the word is a key/property name, not a value -
  // xterm's ITheme has `black:`, `red:`, `cyan:` fields holding var() reads.
  // In CSS a named color is always a value, so it is never followed by `:`.
  // A leading `.` means it is a member of something rather than a value: the
  // role ids in theme/roles.ts are dotted (`ansi.black`, `ansi.green`), and a
  // CSS value never has a dot immediately before the colour name.
  //
  // The generated seti mapping stores `"hue": "green"` for 405 file types
  // precisely so the value comes from the theme's scale.* role rather than being
  // frozen into the file, so flagging those would be flagging the fix. That one
  // exemption is handled by isQuotedHueName below, scoped as narrowly as it can
  // be: eight of the eleven hue names are also real CSS colours.
  [new RegExp(`(?<![\\w.-])(?:${NAMED.join("|")})(?![\\w-])(?!\\s*:)`, "g"), "CSS named color"],
];

/** The hue names the scale.* roles declare, e.g. `red` from `scale.red`. These
 *  are names the token layer resolves, so a quoted one is a reference, not a
 *  literal. Derived from ROLES so adding a hue needs no edit here. */
const SCALE_HUES = new Set(
  ROLES.filter((r) => r.group === "scale").map((r) => r.id.split(".")[1]),
);

/** The one file allowed to name a hue: the generated seti mapping. */
const HUE_MAPPING = "src/seti/mapping.ts";

/**
 * Whether this match is the seti mapping's hue NAME rather than a colour value.
 *
 * Narrow on three axes at once - the file, the position, and the declared scale
 * names - because `red`, `green`, `blue`, `yellow`, `orange`, `purple`, `pink`,
 * and `silver` are all real CSS colours. An exemption keyed on quoting alone
 * would wave through `color: "red"` in any component, blinding check 1 to
 * exactly the literals it exists to catch.
 *
 * Two positions, because gen-seti.mjs emits the names twice: as `"hue": "green"`
 * on each entry, and as `| "green"` in the SetiHue union that makes a bad hue a
 * type error. Anywhere else in the file, including a bare `const x = "green"`,
 * still fails.
 */
const HUE_POSITIONS = [/"hue":\s*$/, /\|\s*$/];

function isQuotedHueName(rel, text, match, index) {
  if (rel !== HUE_MAPPING || !SCALE_HUES.has(match)) return false;
  const before = text[index - 1];
  const after = text[index + match.length];
  if (before !== '"' || after !== '"') return false;
  const preceding = text.slice(0, index - 1);
  return HUE_POSITIONS.some((position) => position.test(preceding));
}

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
      // Every match, not just the first: a line can carry an exempt hue name
      // and a real literal at once, and stopping at the first would hide one
      // behind the other.
      for (const match of line.matchAll(pattern)) {
        if (isQuotedHueName(rel, line, match[0], match.index)) continue;
        violations.push({ rel, line: i + 1, label, text: line.trim() });
        break;
      }
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
  [
    "src/seti/FileIcon.tsx",
    {
      prefixes: ["--scale-"],
      reason:
        "the icon's hue comes from the generated seti mapping, e.g. var(--scale-${icon().hue}). " +
        "Check 6 below closes the loop by proving every hue that mapping can emit is a declared scale role",
    },
  ],
  [
    "src/panels/Editor/semanticHighlight.ts",
    {
      prefixes: ["--syntax-"],
      reason:
        "one CSS rule is generated per semantic token type, e.g. var(--syntax-${role}), from the map in " +
        "src/utils/semanticTokens.ts. Check 7 below closes the loop by proving every role that map can " +
        "emit is a declared syntax role",
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

// ---- Check 5: every token the workbench names as a string exists ----
//
// Same shape of blind spot as check 4. The workbench renders its swatches as
// `var(${name})`, so check 3 sees only an interpolation and waves them through.
// A name that resolves to nothing renders an empty chip, which reads as "that
// role has no colour" rather than as a typo.
//
// The role gallery itself is derived from ROLES now and so cannot go stale, but
// the annotations, the samples, and the `--ui-*` writes still carry names as
// literals. So this scans every `"--x"` in the file rather than the contents of
// two named consts: it needs no update when a const is renamed or split, and it
// covers the parts of the workbench that are still hand-written.

const STYLEGUIDE = "src/dev/Styleguide.tsx";
const guideSource = sources.get(STYLEGUIDE);
const guideProblems = [];

if (!guideSource) {
  guideProblems.push(`could not read ${STYLEGUIDE}; this check needs the workbench`);
} else {
  const named = [...guideSource.matchAll(/["'`](--[\w-]+)["'`]/g)].map((m) => m[1]);
  if (named.length === 0) {
    guideProblems.push(`${STYLEGUIDE} names no --tokens as literals; the form this check scans for changed`);
  }
  for (const name of new Set(named)) {
    // globalNames is the token layer plus every role plus every runtime write,
    // i.e. exactly what a `var()` in the workbench can resolve against.
    if (!globalNames.has(name)) {
      guideProblems.push(`${STYLEGUIDE} names ${name}, which no role and no token declaration provides`);
    }
  }
}

if (guideProblems.length > 0) {
  console.error(`${guideProblems.length} problem(s) in the theme workbench:\n`);
  for (const problem of guideProblems) console.error(`  ${problem}`);
  console.error("\nA workbench name that resolves to nothing renders an empty swatch rather than an error.");
  process.exit(1);
}

// ---- Check 6: every seti hue is a declared scale role ----
//
// FileIcon builds `var(--scale-${hue})` at runtime, so check 3 can only be told
// to trust it. This is what earns that trust: the generated mapping's hue set
// must be exactly the scale.* roles. A hue with no role paints nothing and the
// icon inherits the row's text colour, which looks like a theming choice rather
// than a missing token.

const MAPPING = "src/seti/mapping.ts";
const mappingSource = sources.get(MAPPING);
const emitted = new Set([...(mappingSource ?? "").matchAll(/"hue":\s*"([\w-]+)"/g)].map((m) => m[1]));
const declared = new Set(ROLES.filter((r) => r.group === "scale").map((r) => r.id.split(".")[1]));

const hueProblems = [];
if (!mappingSource) {
  hueProblems.push(`could not read ${MAPPING}; this check needs the generated seti mapping`);
} else if (emitted.size === 0) {
  hueProblems.push(`${MAPPING} emitted no hues; the "hue": "..." form this check scans for changed`);
}
for (const hue of emitted) {
  if (!declared.has(hue)) hueProblems.push(`${MAPPING} emits hue "${hue}", which has no scale.${hue} role`);
}
for (const hue of declared) {
  if (!emitted.has(hue)) hueProblems.push(`scale.${hue} is declared but no file type uses it; run scripts/gen-seti.mjs`);
}

if (hueProblems.length > 0) {
  console.error(`${hueProblems.length} problem(s) in the file-icon hue mapping:\n`);
  for (const problem of hueProblems) console.error(`  ${problem}`);
  console.error("\nThe seti mapping and the scale.* roles must name the same hues.");
  process.exit(1);
}

// ---- Check 7: every semantic-token role is a declared syntax role ----
//
// `semanticHighlight.ts` generates one CSS rule per entry of its token-type map,
// as `var(--syntax-${role})`, so check 3 can only be told to trust it. This is
// what earns that trust. The failure it catches is the quietest one in the
// editor: a role with no token resolves to nothing, the element inherits, and
// the identifier keeps the colour the *grammar* gave it - which is exactly what
// it looks like when the language server is not running. Nobody attributes that
// to a missing token.

const semanticProblems = [];
if (SEMANTIC_ROLES.length === 0) {
  semanticProblems.push("src/utils/semanticTokens.ts exports no SEMANTIC_ROLES; the map this check reads changed");
}
for (const role of SEMANTIC_ROLES) {
  if (!globalNames.has(`--syntax-${role}`)) {
    semanticProblems.push(`semantic tokens paint with --syntax-${role}, which no role declares`);
  }
}

if (semanticProblems.length > 0) {
  console.error(`${semanticProblems.length} problem(s) in the semantic-token colours:\n`);
  for (const problem of semanticProblems) console.error(`  ${problem}`);
  console.error("\nA semantic role with no token silently leaves the grammar's colour in place.");
  process.exit(1);
}

// ---- Check 8: the Omnibox palette declares its own height bound ----
//
// The palette composes `Dialog` now (#110), so it inherits a bound rather than
// having none. But it wants a shorter one than a dialog's 85vh, because its list
// is longer than a dialog's body, and with MAX_RESULTS at 200 a panel bounded
// too generously still puts rows above the fold out of reach.
//
// It asks for that through `Dialog`'s `--dialog-max-height` hook rather than by
// redeclaring `max-height`. That is the part worth guarding: both rules would be
// a single class on the same element, so a plain redeclaration would be settled
// by whichever CSS module the bundler emitted second, and this check would still
// pass while the value it names did nothing. So the property scanned for below
// is the hook, not the bound.
//
// This lives here rather than in vitest for the same reason checks 4 to 7 do:
// the test stack cannot see a CSS rule at all. Vitest stubs CSS Modules, so
// `styles.list` resolves to a class name whether or not any rule declares it,
// and jsdom computes no layout - so a mounted test asserting "the list scrolls"
// passes against a stylesheet that says nothing of the kind. That is exactly
// how the bound was lost the first time: `.picker` carried it, `.picker` was
// deleted when the dialogs' picker moved inside `Dialog`, and the suite stayed
// green through all of it.

// Named for the Omnibox rather than "the palette": in this file a palette is a
// theme's colour palette (see PALETTE_DIR above), and one word cannot be both.
const OMNIBOX_CSS = "src/components/Omnibox/Omnibox.module.css";
const omniboxSource = sources.get(OMNIBOX_CSS);

// Comments are already stripped from `sources`, so a rule is a selector list and
// a body. At-rules are skipped: their "body" is nested rules, not declarations.
const cssRules = (source) =>
  [...(source ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }))
    .filter((rule) => !rule.selectors.some((s) => s.startsWith("@")));

const declares = (rules, selector, property) =>
  rules
    .filter((rule) => rule.selectors.includes(selector))
    .some((rule) => new RegExp(`(^|;)\\s*${property}\\s*:`).test(rule.body));

const omniboxRules = cssRules(omniboxSource);

// What the command palette must declare, and what breaks when it does not.
const OMNIBOX_BOUND = [
  [
    ".panel",
    "--dialog-max-height",
    "the palette takes a dialog's 85vh instead of its own shorter bound, and the rows past it go out of reach",
  ],
];

const omniboxProblems = [];
if (!omniboxSource) {
  omniboxProblems.push(`could not read ${OMNIBOX_CSS}; this check needs the command palette's stylesheet`);
} else if (omniboxRules.length === 0) {
  omniboxProblems.push(`${OMNIBOX_CSS} parsed to no rules; the shape this check scans for changed`);
}
for (const [selector, property, consequence] of OMNIBOX_BOUND) {
  if (!omniboxRules.some((rule) => rule.selectors.includes(selector))) {
    omniboxProblems.push(`${OMNIBOX_CSS} has no ${selector} rule, so ${consequence}`);
  } else if (!declares(omniboxRules, selector, property)) {
    omniboxProblems.push(`${selector} does not declare ${property}, so ${consequence}`);
  }
}

// The other half of the bound, in a file that has no reason to know this check
// exists. Two things are asked of it: that it still reads the hook the palette
// sets, and that its body is still the scroller. The palette's own list stopped
// being one when it moved onto the shared <Combobox> (#110) - the rows are the
// dialog body's children now, and a bound with nothing scrolling under it puts
// the rows past it out of reach exactly as no bound at all does.
const DIALOG_CSS = "src/components/Dialog/Dialog.module.css";
const dialogSource = sources.get(DIALOG_CSS);
if (!dialogSource) {
  omniboxProblems.push(`could not read ${DIALOG_CSS}; this check needs the dialog panel's stylesheet`);
} else {
  if (!/max-height:\s*var\(\s*--dialog-max-height/.test(dialogSource)) {
    omniboxProblems.push(
      `${DIALOG_CSS} no longer reads --dialog-max-height, so the palette sets a variable nothing consumes`,
    );
  }
  if (!declares(cssRules(dialogSource), ".body", "overflow-y")) {
    omniboxProblems.push(
      `${DIALOG_CSS} has no .body rule declaring overflow-y, so the palette's rows overflow its bound with no way to scroll to them`,
    );
  }
}

if (omniboxProblems.length > 0) {
  console.error(`${omniboxProblems.length} problem(s) in the command palette's height bound:\n`);
  for (const problem of omniboxProblems) console.error(`  ${problem}`);
  console.error("\nNothing above the palette bounds it, and no test can see a CSS rule; it must bound itself.");
  process.exit(1);
}

// ---- Check 8b: a tool row's text cells can shrink ----
//
// A row that cannot shrink is wider than its column, and a row wider than its
// column puts a horizontal scrollbar across the whole transcript. Here rather
// than in vitest because jsdom lays nothing out, so no test can see a width.
const CHAT_CSS = "src/panels/Chat/Chat.module.css";
const chatSource = sources.get(CHAT_CSS);
const chatRules = cssRules(chatSource);
const SHRINKABLE = ["min-width", "overflow", "text-overflow"];
const rowProblems = [];
if (!chatSource) {
  rowProblems.push(`could not read ${CHAT_CSS}; this check needs the chat's stylesheet`);
} else {
  for (const selector of [".toolName", ".toolArg"]) {
    if (!chatRules.some((rule) => rule.selectors.includes(selector))) {
      rowProblems.push(`${CHAT_CSS} has no ${selector} rule, so the shape this check scans for changed`);
      continue;
    }
    for (const property of SHRINKABLE) {
      if (!declares(chatRules, selector, property)) {
        rowProblems.push(
          `${selector} does not declare ${property}, so a long command in it widens the row past the ` +
            `transcript and scrolls the whole chat sideways`,
        );
      }
    }
  }
}

if (rowProblems.length > 0) {
  console.error(`${rowProblems.length} problem(s) in the tool row's text cells:\n`);
  for (const problem of rowProblems) console.error(`  ${problem}`);
  console.error("\nA row is as wide as its widest cell, and the transcript is as wide as its widest row.");
  process.exit(1);
}

// ---- Check 8c: the sidebar filter opens beside the tabs or under them ----
//
// The rule is the row's wrap: the field asks for a 120px basis and takes the
// next line when the tabs leave it less. Both halves are CSS, and jsdom lays
// nothing out, so this is the only place the pair can be held together.
const SIDEBAR_CSS = "src/panels/LeftSidebar/LeftSidebar.module.css";
const sidebarRules = cssRules(sources.get(SIDEBAR_CSS));
const filterProblems = [];
if (!sources.get(SIDEBAR_CSS)) {
  filterProblems.push(`could not read ${SIDEBAR_CSS}; this check needs the sidebar's stylesheet`);
} else {
  if (!declares(sidebarRules, ".treeHead", "flex-wrap")) {
    filterProblems.push(
      ".treeHead does not declare flex-wrap, so the filter is squeezed onto the tabs' line at every width",
    );
  }
  for (const property of ["flex", "min-width"]) {
    if (!declares(sidebarRules, ".searchInput", property)) {
      filterProblems.push(
        `.searchInput does not declare ${property}, so nothing states the width below which it moves under the tabs`,
      );
    }
  }
}

if (filterProblems.length > 0) {
  console.error(`${filterProblems.length} problem(s) in the sidebar filter's row:\n`);
  for (const problem of filterProblems) console.error(`  ${problem}`);
  console.error("\nBeside the tabs or under them is a wrap, and a wrap needs both a wrapping row and a basis.");
  process.exit(1);
}

// ---- Check 9: the palette's heading still reads as a dialog title ----
//
// The palette's real title is `titleHidden` (the visible line names the *mode*,
// not the surface), so the heading a reader actually sees is the Omnibox's own
// `.title`, and it exists to look exactly like a dialog title. That makes it a
// copy of `Dialog`'s `.title` recipe living in another file.
//
// It cannot be shared: a cross-module `composes` is what this cluster
// deliberately does not do (see the header of Dialogs.module.css), and both
// rules landing on one element would put the winner in the bundler's hands. So
// the copy stays and the agreement is guarded instead - which is the same shape
// as check 8 above, for the same file pair and the same reason.
//
// #130 is what made this necessary: moving Dialog's title from 16px to 18px
// silently left the palette's heading two steps smaller, and nothing failed.
// The margin is deliberately not compared: the heading sits inside the dialog's
// *body*, which is a plain scroller, so it needs a margin the head does not.
const valueOf = (rules, selector, property) => {
  for (const rule of rules.filter((r) => r.selectors.includes(selector))) {
    const m = rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`));
    if (m) return m[1].trim();
  }
  return undefined;
};

// What a dialog title *is*, as opposed to where it sits.
const TITLE_RECIPE = ["font-size", "line-height", "font-weight", "color"];
const titleProblems = [];
const dialogRules = cssRules(dialogSource);
for (const property of TITLE_RECIPE) {
  const ours = valueOf(dialogRules, ".title", property);
  const theirs = valueOf(omniboxRules, ".title", property);
  if (ours === undefined) {
    titleProblems.push(`${DIALOG_CSS} .title no longer declares ${property}, so there is nothing to match`);
  } else if (theirs === undefined) {
    titleProblems.push(`${OMNIBOX_CSS} .title does not declare ${property}, so the palette heading drifts from a dialog title`);
  } else if (ours !== theirs) {
    titleProblems.push(`${property}: ${DIALOG_CSS} says ${ours}, ${OMNIBOX_CSS} says ${theirs}`);
  }
}

if (titleProblems.length > 0) {
  console.error(`${titleProblems.length} disagreement(s) between the dialog title and the palette's heading:\n`);
  for (const problem of titleProblems) console.error(`  ${problem}`);
  console.error("\nThe palette hides its real title and draws its own, so the two recipes must stay identical.");
  process.exit(1);
}

// ---- Check 10: the blocking tier is worn by exactly two surfaces ----
//
// A permission prompt and a question card both stop the turn and wait on the
// user. Until the tier existed they each spelled that out as `--brand-default`
// over `--canvas-card`, so nothing held them together and neither could be
// restyled without moving the brand everywhere else. The roles give the pair one
// name; this keeps the pair honest in both directions.
//
// Sharing the ROLES matters more than sharing the values: two rules that happen
// to name the same colour drift the first time one of them is edited, and the
// drift is invisible because both still look gold. So the frame, the fill and
// the radius are compared as declarations, not as rendered colour.
//
// The other half is the ambient rows. A tool call is plumbing, a thinking block
// is an aside, a notice is news: none of them stops the turn, and a third rule
// reaching for the blocking fill would make "this stopped the turn" mean less
// every time it appeared. Here rather than in vitest for the reason at the top
// of this file: a CSS import is stubbed to the empty string under test.
/** The two surfaces that may wear the tier. Prefixes: `.promptQuestion` and
 *  `.questionTitle` are parts of the same two cards. */
const BLOCKING = [".prompt", ".question"];
/** What both must declare identically, and what a disagreement costs. */
const BLOCKING_SHARED = [
  ["border", "one card is framed differently from the other"],
  ["background", "one card sits on a different surface from the other"],
  ["border-radius", "one card is shaped differently from the other"],
];
// Two copies of one pattern: the sticky `g` form is for scanning a rule body,
// the plain one for asking whether a single value names a role. Sharing one
// would mean carrying `lastIndex` between the two loops below.
const TIER_VARS = /var\(\s*(--blocking-[\w-]+)\s*\)/g;
const NAMES_TIER = /var\(\s*--blocking-[\w-]+\s*\)/;

const blockingProblems = [];
if (!chatSource) {
  blockingProblems.push(`could not read ${CHAT_CSS}; this check needs the chat panel's stylesheet`);
} else if (chatRules.length === 0) {
  blockingProblems.push(`${CHAT_CSS} parsed to no rules; the shape this check scans for changed`);
} else {
  for (const [property, consequence] of BLOCKING_SHARED) {
    const values = BLOCKING.map((selector) => [selector, valueOf(chatRules, selector, property)]);
    for (const [selector, value] of values) {
      if (value === undefined) {
        blockingProblems.push(`${selector} declares no ${property}, so the blocking tier is not applied to it`);
      } else if (property !== "border-radius" && !NAMES_TIER.test(value)) {
        // The radius is exempt because there is no radius role and no reason for
        // one: what it has to be is the SAME on both cards, which the agreement
        // below already says.
        blockingProblems.push(`${selector} sets ${property} to ${value}, which names no --blocking-* role`);
      }
    }
    // Every card against the first, not the first two against each other: a
    // third blocking surface must join the agreement rather than slip past it.
    const [[firstSelector, first], ...rest] = values;
    for (const [selector, value] of rest) {
      if (first !== undefined && value !== undefined && value !== first) {
        blockingProblems.push(
          `${property}: ${firstSelector} says ${first}, ${selector} says ${value}, so ${consequence}`,
        );
      }
    }
  }

  for (const rule of chatRules) {
    const worn = [...rule.body.matchAll(TIER_VARS)].map((m) => m[1]);
    if (worn.length === 0) continue;
    for (const selector of rule.selectors) {
      if (!BLOCKING.some((b) => selector.startsWith(b))) {
        blockingProblems.push(
          `${selector} reads ${[...new Set(worn)].join(", ")} but is not a blocking surface; ` +
            `the tier says "this stopped the turn" and means less on every extra row that wears it`,
        );
      }
    }
  }
}

const tierRoles = ROLES.filter((r) => r.group === "blocking");
if (tierRoles.length === 0) {
  blockingProblems.push("no role declares group \"blocking\", so there is no tier for the two cards to share");
}
for (const role of tierRoles) {
  if (!(chatSource ?? "").includes(`var(${role.cssVar})`)) {
    blockingProblems.push(`${role.cssVar} is declared but nothing in ${CHAT_CSS} reads it`);
  }
}

if (blockingProblems.length > 0) {
  console.error(`${blockingProblems.length} problem(s) with the chat's blocking tier:\n`);
  for (const problem of blockingProblems) console.error(`  ${problem}`);
  console.error("\nThe prompt and the question card interrupt the user for the same reason; they must look it.");
  process.exit(1);
}

console.log(
  `Token check passed: no color literals outside tokens.css ` +
    `(${ALLOWLIST.size} allowlisted files, ${ALLOWLIST_PREFIXES.size} allowlisted ` +
    `${ALLOWLIST_PREFIXES.size === 1 ? "directory" : "directories"}), ` +
    `${palettes.length} palettes each producing all ${ROLES.length} roles, ` +
    `every var() in src/ resolving, all ${termNames.length} terminal reads mapped, ` +
    `every token the workbench names resolving, all ${emitted.size} seti hues backed by scale roles, ` +
    `all ${SEMANTIC_ROLES.length} semantic-token roles backed by syntax roles, ` +
    `the command palette bounding its own height, ` +
    `a tool row's 2 text cells able to shrink, ` +
    `the sidebar filter's row able to wrap under its tabs, ` +
    `its heading matching a dialog title on all ${TITLE_RECIPE.length} recipe properties, ` +
    `and the blocking tier's ${tierRoles.length} roles worn by the ${BLOCKING.length} surfaces that interrupt the user.`,
);
