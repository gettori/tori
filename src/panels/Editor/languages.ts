// Which CodeMirror language a path gets, and what rides along with it.
//
// Lifted out of CodeEditor.tsx so the mapping can be asserted without mounting
// the pane: "a .css buffer gets colour swatches and a .ts buffer does not" is a
// property of this table, and the pane is not involved in it.
//
// Editor-side, behind the lazy boundary: it imports CodeMirror.
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { Extension } from "@codemirror/state";

// Packs beyond ts/js/json load on demand so the (already lazy) editor chunk
// stays lean; the module cache makes every open after the first free. The
// suffix comes from the basename so a dotted directory can't fake one, and
// dotfiles like .zshrc resolve to their own name.
export async function langForPath(path: string): Promise<Extension> {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = file.split(".").pop() ?? "";
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (ext === "json") return json();
  if (["md", "markdown"].includes(ext)) return (await import("@codemirror/lang-markdown")).markdown();
  // Swatches ride with the CSS pack rather than sitting in the prefs
  // compartment: the picker reads the CSS syntax tree, so it is meaningless in
  // a buffer that has no CSS in it, and pairing them here means it can never be
  // installed against the wrong language.
  if (ext === "css") {
    const [{ css }, { colorPicker }] = await Promise.all([
      import("@codemirror/lang-css"),
      import("@replit/codemirror-css-color-picker"),
    ]);
    return [css(), colorPicker];
  }
  if (["html", "htm"].includes(ext)) return (await import("@codemirror/lang-html")).html();
  if (ext === "rs") return (await import("@codemirror/lang-rust")).rust();
  if (ext === "py") return (await import("@codemirror/lang-python")).python();
  if (["yaml", "yml"].includes(ext)) return (await import("@codemirror/lang-yaml")).yaml();
  if (ext === "toml") return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
  if (["sh", "bash", "zsh", "zshrc", "bashrc"].includes(ext)) return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
  return [];
}
