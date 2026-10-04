// The syntax worker: shikiEngine, off the main thread. `ready` (or `failed`)
// goes out once the highlighter is built, and every request gets exactly one
// reply, so the page can tell a worker that never came up from a slow one.
import { init, canHighlight, isLoaded, loadLang, toHtml, toLines } from "./shikiEngine";
import type { Reply, Request } from "./highlightQueue";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};

const ready = init();
ready.then(
  () => scope.postMessage({ ready: true }),
  (e) => scope.postMessage({ failed: String(e) }),
);

scope.onmessage = async ({ data: { id, code, lang, form } }) => {
  let reply: Reply;
  try {
    await ready;
    if (!canHighlight(lang)) {
      reply = { id, none: true };
    } else {
      if (!isLoaded(lang)) await loadLang(lang);
      reply = { id, value: form === "lines" ? toLines(code, lang) : toHtml(code, lang) };
    }
  } catch (e) {
    reply = { id, error: String(e) };
  }
  scope.postMessage(reply);
};
