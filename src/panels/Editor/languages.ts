// Which CodeMirror language a path gets, and what rides along with it.
//
// Lifted out of CodeEditor.tsx so the mapping can be asserted without mounting
// the pane: "a .css buffer gets colour swatches and a .ts buffer does not" is a
// property of this table, and the pane is not involved in it.
//
// Editor-side, behind the lazy boundary: it imports CodeMirror.
import { LanguageDescription, type Language, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";

function basename(path: string): string {
  return path.split("/").pop() ?? "";
}

// The suffix comes from the basename so a dotted directory can't fake one, and
// dotfiles like .zshrc resolve to their own name.
function suffix(path: string): string {
  return basename(path).toLowerCase().split(".").pop() ?? "";
}

// Already in the editor chunk, so these load without a round trip.
function syncPack(ext: string): LanguageSupport | null {
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (ext === "json") return json();
  return null;
}

// Shell here before language-data, which claims none of them.
const SHELL_SUFFIXES = ["zsh", "zshrc", "bashrc"];

// language-data matches extensions case-sensitively, and its filename patterns
// (`Dockerfile`) are case-sensitive on purpose, so the name is tried as written
// first.
function descriptionFor(path: string): LanguageDescription | null {
  const name = basename(path);
  return (
    LanguageDescription.matchFilename(languages, name) ??
    LanguageDescription.matchFilename(languages, name.toLowerCase()) ??
    (SHELL_SUFFIXES.includes(suffix(path)) ? LanguageDescription.matchLanguageName(languages, "shell") : null)
  );
}

async function packFor(path: string): Promise<LanguageSupport | null> {
  return syncPack(suffix(path)) ?? (await descriptionFor(path)?.load()) ?? null;
}

export async function languageForPath(path: string): Promise<Language | null> {
  return (await packFor(path))?.language ?? null;
}

export async function langForPath(path: string): Promise<Extension> {
  // Swatches ride with the CSS pack rather than sitting in the prefs
  // compartment: the picker reads the CSS syntax tree, so it is meaningless in
  // a buffer that has no CSS in it, and pairing them here means it can never be
  // installed against the wrong language.
  if (suffix(path) === "css") {
    const [pack, { colorPicker }] = await Promise.all([packFor(path), import("@replit/codemirror-css-color-picker")]);
    return [pack ?? [], colorPicker];
  }
  return (await packFor(path)) ?? [];
}
