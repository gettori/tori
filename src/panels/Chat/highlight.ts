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
