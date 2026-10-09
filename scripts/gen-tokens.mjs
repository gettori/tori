#!/usr/bin/env node
// Generate the semantic role blocks in src/styles/tokens.css from the bundled
// palettes, so the boot fallback cannot drift from the generator.
//
// The token layer is still the pre-theme fallback: it is what paints the app
// before the theme engine runs, and it is what a role falls back to when the
// active theme omits it. Hand-maintaining it alongside roles.ts guarantees the
// two disagree eventually, and the disagreement only shows as a flash of the
// wrong colour on boot.
//
// ONLY the region between the two markers is rewritten. The primitives, the
// --ui-* settings defaults, spacing, radii, type, motion, and border widths
// share this file and are hand-maintained; blowing the whole file away would
// take them with it.
//
// Run: node scripts/gen-tokens.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoles, ROLES } from "../src/theme/roles.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TOKENS_PATH = join(ROOT, "src/styles/tokens.css");

const BEGIN = "/* ---- BEGIN GENERATED ROLE TOKENS. Run scripts/gen-tokens.mjs; do not edit by hand. ---- */";
const END = "/* ---- END GENERATED ROLE TOKENS ---- */";

const PALETTES = ["tori-dark", "tori-light"].map((id) =>
  JSON.parse(readFileSync(join(ROOT, `src-tauri/packs/themes/${id}.json`), "utf8")),
);

/** Group roles for readability, in the order roles.ts declares them. */
function emitBlock(selector, palette, marker) {
  const values = buildRoles(palette);
  const lines = [`  /* ---- ${marker} ---- */`, `  ${selector} {`];
  let group = null;
  for (const role of ROLES) {
    if (role.group !== group) {
      if (group !== null) lines.push("");
      lines.push(`    /* ${role.group} */`);
      group = role.group;
    }
    lines.push(`    ${role.cssVar}: ${values[role.cssVar]};`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function render() {
  const [dark, light] = PALETTES;
  return [
    `  ${BEGIN}`,
    "",
    "  /* Derived from src-tauri/packs/themes/*.json by src/theme/roles.ts. Values are",
    "     literal because this is a fallback: it must paint correctly before any",
    "     script runs, so it cannot depend on the runtime that resolves palettes. */",
    "",
    // The dark block doubles as the bare :root default, so an unthemed boot is
    // dark rather than unstyled.
    emitBlock(`:root,\n  :root[data-theme="dark"]`, dark, "Semantic tokens, dark (default)"),
    "",
    emitBlock(`:root[data-theme="light"]`, light, "Semantic tokens, light"),
    "",
    `  ${END}`,
  ].join("\n");
}

/** tokens.css as it is on disk, and as the palettes say it should be.
 *
 *  Exported so the token guard can assert the two agree without shelling out or
 *  re-deriving the region format, which would be a second definition of "what
 *  generated looks like" and would drift from this one. */
export function tokensCss() {
  const current = readFileSync(TOKENS_PATH, "utf8");
  const start = current.indexOf(BEGIN);
  const stop = current.indexOf(END);
  if (start < 0 || stop < 0) {
    throw new Error(`tokens.css is missing the generated-region markers.\nExpected:\n  ${BEGIN}\n  ${END}`);
  }

  // Cut at the START OF THE MARKER'S LINE, not at a fixed column. The markers are
  // indented inside @layer tokens, and assuming a width means a reindent silently
  // eats a character or strands the old indent in a generated file.
  const before = current.slice(0, current.lastIndexOf("\n", start) + 1);
  const after = current.slice(stop + END.length);
  return { current, next: `${before}${render()}${after}` };
}

/** Only when run directly: importing this must not rewrite the file. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let current, next;
  try {
    ({ current, next } = tokensCss());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    if (next !== current) {
      console.error("src/styles/tokens.css is stale: the generated region does not match the palettes.");
      console.error("Run: node scripts/gen-tokens.mjs");
      process.exit(1);
    }
    console.log("tokens.css generated region is up to date.");
  } else {
    writeFileSync(TOKENS_PATH, next);
    console.log(`Wrote ${ROLES.length} roles x ${PALETTES.length} themes into the generated region of tokens.css.`);
  }
}
