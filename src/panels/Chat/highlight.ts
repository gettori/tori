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

export function highlightedHtml(code: string, lang: string): string | null {
  version();
  const name = lang.trim().toLowerCase();
  if (!name) return null;
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
    return null;
  }
  if (!engine.canHighlight(name)) return null;
  if (!engine.isLoaded(name)) {
    if (!requestedLangs.has(name)) {
      requestedLangs.add(name);
      engine.loadLang(name).then(bump, () => {});
    }
    return null;
  }
  return engine.toHtml(code, name);
}
