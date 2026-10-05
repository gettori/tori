// Regenerate src/seti/mapping.ts from VS Code's theme-seti icon theme.
//
//   node scripts/gen-seti.mjs
//
// The source `vs-seti-icon-theme.json` resolves mainstream file types
// (ts, js, json, md, css, ...) through `languageIds`, NOT `fileExtensions`
// (which only holds long-tail types). VS Code bridges extension -> languageId
// via each language extension's contribution; that table is not in the theme
// JSON, so we keep a curated bridge here and fold languageIds into a flat
// extension map. The emitted mapping.ts is therefore filename-only at runtime
// (no languageIds lookup needed): { fileNames, extensions, default }.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const theme = JSON.parse(fs.readFileSync(path.join(here, "vs-seti-icon-theme.json"), "utf8"));

// "\\E001" (JSON) -> { glyph: the PUA char at U+E001, color: the seti fontColor }.
function iconOf(defId) {
  const def = theme.iconDefinitions[defId];
  if (!def || !def.fontCharacter) return null;
  const m = /\\([0-9A-Fa-f]+)/.exec(def.fontCharacter);
  if (!m) return null;
  return { glyph: String.fromCodePoint(parseInt(m[1], 16)), color: def.fontColor || null };
}

// Curated extension -> seti languageId. Covers the common dev types VS Code
// would resolve via its language layer. Long-tail types come from the theme's
// own fileExtensions map (overlaid below).
const EXT_TO_LANG = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  "d.ts": "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  jsonl: "jsonl",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  styl: "stylus",
  py: "python",
  pyw: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  elm: "elm",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  coffee: "coffeescript",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  groovy: "groovy",
  jl: "julia",
  m: "objective-c",
  mm: "objective-cpp",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  tex: "tex",
  latex: "latex",
  bat: "bat",
  cmd: "bat",
  properties: "properties",
  ini: "properties",
  cfg: "properties",
  tf: "terraform",
  tfvars: "terraform",
  bicep: "bicep",
  vala: "vala",
  hx: "haxe",
  haml: "haml",
  jade: "jade",
  pug: "jade",
  gradle: "gradle",
  gd: "godot",
  res: "rescript",
  resi: "rescript",
};

const def = iconOf(theme.file);
if (!def) throw new Error("could not resolve default icon");
// Some defs carry no fontColor; fall back to the default icon's, so every entry
// resolves to a hue rather than to nothing.
const FALLBACK = def.color || "#d4d7d6";

// Seti ships 406 per-type colours drawn from only 11 distinct hues, all picked
// against VS Code's DARK canvas. Emitting those hexes pinned the file tree to a
// dark palette no matter the theme. So the generator emits a hue NAME and the
// theme supplies the value, via the scale.* role family.
//
// Unknown hex is a hard error rather than a fallback: seti adding a 12th hue
// upstream is exactly the moment a human needs to name it and both palettes
// need a value. Silently folding it into "silver" would lose a colour that the
// icon set considers meaningful, and nothing downstream would ever say so.
const HEX_TO_HUE = new Map([
  ["#cc3e44", "red"],
  ["#8dc149", "green"],
  ["#519aba", "blue"],
  ["#cbcb41", "yellow"],
  ["#6d8086", "slate"],
  ["#e37933", "orange"],
  ["#a074c4", "purple"],
  ["#f55385", "pink"],
  ["#d4d7d6", "silver"],
  ["#41535b", "steel"],
  ["#4d5a5e", "graphite"],
]);

function hueOf(hex) {
  const hue = HEX_TO_HUE.get((hex || FALLBACK).toLowerCase());
  if (!hue) {
    throw new Error(
      `seti colour ${hex} has no hue name. Add it to HEX_TO_HUE here, add a ` +
        `scale.<name> role in src/theme/roles.ts, and give every palette in ` +
        `src/theme/palettes/ a value for it.`,
    );
  }
  return hue;
}

const norm = (ic) => ({ glyph: ic.glyph, hue: hueOf(ic.color) });

// extension -> {glyph,color}. languageIds-derived first, theme fileExtensions
// overlaid (explicit, long-tail entries win on conflict).
const extensions = {};
for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
  const ic = iconOf(theme.languageIds[lang]);
  if (ic) extensions[ext] = norm(ic);
}
for (const [ext, defId] of Object.entries(theme.fileExtensions)) {
  const ic = iconOf(defId);
  if (ic) extensions[ext] = norm(ic);
}

// exact filename -> {glyph,color}.
const fileNames = {};
for (const [name, defId] of Object.entries(theme.fileNames)) {
  const ic = iconOf(defId);
  if (ic) fileNames[name] = norm(ic);
}

const defaultIcon = norm(def);

const banner =
  "// GENERATED by scripts/gen-seti.mjs from VS Code's theme-seti. Do not edit by hand.\n" +
  "// Glyphs are Private Use Area chars rendered with the bundled `seti` webfont.\n" +
  "// `hue` names one of the 11 scale.* roles; the active theme supplies the value,\n" +
  "// so the file tree follows the theme instead of seti's dark variant.\n";
const body =
  "export type SetiHue =\n" +
  [...new Set(HEX_TO_HUE.values())].map((h) => `  | "${h}"`).join("\n") +
  ";\n\n" +
  "export type SetiIcon = { glyph: string; hue: SetiHue };\n\n" +
  `export const fileNames: Record<string, SetiIcon> = ${JSON.stringify(fileNames, null, 2)};\n\n` +
  `export const extensions: Record<string, SetiIcon> = ${JSON.stringify(extensions, null, 2)};\n\n` +
  `export const defaultIcon: SetiIcon = ${JSON.stringify(defaultIcon)};\n`;

const out = path.join(here, "..", "src", "seti", "mapping.ts");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, banner + "\n" + body);
console.log(
  `wrote ${out}: ${Object.keys(fileNames).length} fileNames, ` +
    `${Object.keys(extensions).length} extensions, default hue ${defaultIcon.hue}`,
);
