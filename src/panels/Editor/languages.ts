// Which CodeMirror language a path gets, and what rides along with it.
//
// Lifted out of CodeEditor.tsx so the mapping can be asserted without mounting
// the pane: "a .css buffer gets colour swatches and a .ts buffer does not" is a
// property of this table, and the pane is not involved in it.
//
// Editor-side, behind the lazy boundary: it imports CodeMirror.
import { LanguageSupport, StreamLanguage, type Language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";

// The suffix comes from the basename so a dotted directory can't fake one, and
// dotfiles like .zshrc resolve to their own name.
function suffix(path: string): string {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  return file.split(".").pop() ?? "";
}

// Packs beyond ts/js/json load on demand so the (already lazy) editor chunk
// stays lean; the module cache makes every open after the first free.
async function packFor(ext: string): Promise<LanguageSupport | Language | null> {
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (ext === "json") return json();
  if (["md", "markdown"].includes(ext)) return (await import("@codemirror/lang-markdown")).markdown();
  if (ext === "css") return (await import("@codemirror/lang-css")).css();
  if (["html", "htm"].includes(ext)) return (await import("@codemirror/lang-html")).html();
  if (ext === "rs") return (await import("@codemirror/lang-rust")).rust();
  if (ext === "py") return (await import("@codemirror/lang-python")).python();
  if (["yaml", "yml"].includes(ext)) return (await import("@codemirror/lang-yaml")).yaml();
  if (ext === "toml") return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
  if (["sh", "bash", "zsh", "zshrc", "bashrc"].includes(ext)) return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
  return null;
}

export async function languageForPath(path: string): Promise<Language | null> {
  const pack = await packFor(suffix(path));
  return pack instanceof LanguageSupport ? pack.language : pack;
}

export async function langForPath(path: string): Promise<Extension> {
  const ext = suffix(path);
  // Swatches ride with the CSS pack rather than sitting in the prefs
  // compartment: the picker reads the CSS syntax tree, so it is meaningless in
  // a buffer that has no CSS in it, and pairing them here means it can never be
  // installed against the wrong language.
  if (ext === "css") {
    const [pack, { colorPicker }] = await Promise.all([packFor(ext), import("@replit/codemirror-css-color-picker")]);
    return [pack ?? [], colorPicker];
  }
  return (await packFor(ext)) ?? [];
}
