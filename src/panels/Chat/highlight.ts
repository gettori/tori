// The eager face of chat syntax highlighting: a synchronous, reactive lookup
// that answers null until the lazily imported shiki engine and the language's
// grammar have both arrived, then answers highlighted HTML. Callers render
// plain text on null and upgrade in place when the version signal bumps.
import { createSignal } from "solid-js";

type Engine = typeof import("./shikiEngine");

const [version, setVersion] = createSignal(0);
let engine: Engine | null = null;
let engineRequested = false;
const requestedLangs = new Set<string>();

const bump = () => setVersion((v) => v + 1);

// Above this a block is pasted output, not code being read, and a TextMate
// pass over it would be the one thing on the streaming path worth feeling.
export const HIGHLIGHT_MAX = 100_000;

/** `highlightedHtml`, refused for a block too big to be worth the pass. Every
 *  caller that renders a block of anything goes through this rather than
 *  keeping its own idea of too big. */
export function cappedHtml(code: string, lang: string): string | null {
  return code.length > HIGHLIGHT_MAX ? null : highlightedHtml(code, lang);
}

/**
 * The same, one string of HTML per line, for a body that puts a gutter or a
 * diff marker beside the code.
 *
 * Null on exactly the same terms as `cappedHtml`, and callers render their own
 * plain text on it. The whole block is tokenized at once, so a comment or a
 * string spanning several lines stays one thing.
 */
export function cappedLines(code: string, lang: string): string[] | null {
  if (code.length > HIGHLIGHT_MAX) return null;
  version();
  const name = lang.trim().toLowerCase();
  if (!name || !ready(name)) return null;
  return engine!.toLines(code, name);
}

// Shiki bundles most extensions as grammar aliases already, so this is only the
// handful where the name on disk is not one of them.
const ALIASES: Record<string, string> = {
  htm: "html",
  h: "c",
  hpp: "cpp",
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  yml: "yaml",
  zshrc: "shell",
  bashrc: "shell",
};

/** The grammar a file's own name implies, for a body rendering that file's
 *  content. Empty when the name says nothing, which highlights as plain. */
export function langOfPath(path: string): string {
  // From the basename, so a dotted directory cannot fake a suffix, and a
  // dotfile like `.zshrc` resolves to its own name.
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = file.replace(/^\./, "").split(".").pop() ?? "";
  return ALIASES[ext] ?? ext;
}

export function highlightedHtml(code: string, lang: string): string | null {
  version();
  const name = lang.trim().toLowerCase();
  if (!name || !ready(name)) return null;
  return engine!.toHtml(code, name);
}

/** Whether this language can be painted right now, asking for whatever is
 *  missing on the way past. False until the engine and the grammar are both in,
 *  and false forever for a language shiki does not ship. */
function ready(name: string): boolean {
  if (!engine) {
    if (!engineRequested) {
      engineRequested = true;
      import("./shikiEngine").then(
        async (m) => {
          await m.init();
          engine = m;
          bump();
        },
        // A failed chunk load leaves every block plain, which is the fallback
        // rendering anyway; nothing retries because nothing would change.
        () => {},
      );
    }
    return false;
  }
  if (!engine.canHighlight(name)) return false;
  if (!engine.isLoaded(name)) {
    if (!requestedLangs.has(name)) {
      requestedLangs.add(name);
      engine.loadLang(name).then(bump, () => {});
    }
    return false;
  }
  return true;
}
