// The eager face of chat syntax highlighting. Shiki runs in a worker, and a
// block reads its colours through `createHighlight`, which answers null until
// the first reply lands and repaints in place on each one after.
import { createSignal, onCleanup } from "solid-js";
import { createQueue, type Answer, type Form, type Reply, type Request } from "./highlightQueue";
import { escapeHtml } from "./escapeHtml";
import { startWorker } from "../../utils/startWorker";

type Engine = typeof import("./shikiEngine");

// Above this a block is pasted output, not code being read, and a TextMate
// pass over it would be the one thing on the streaming path worth feeling.
export const HIGHLIGHT_MAX = 100_000;

// `worker` covers one still starting: what is posted before it is up waits in
// its message queue.
type Mode = "off" | "worker" | "main";

const [mode, setMode] = createSignal<Mode>("off");
let worker: Worker | null = null;
const queue = createQueue((req) => worker?.postMessage(req));

function start(): void {
  // No Worker at all is the test environment, not a failure worth a warning.
  if (typeof Worker === "undefined") return void setMode("main");
  setMode("worker");
  worker = startWorker(
    () => new Worker(new URL("./shikiWorker.ts", import.meta.url), { type: "module" }),
    (data) => queue.receive(data as Reply),
    (why) => {
      worker = null;
      console.warn("[highlight] the syntax worker did not start; code will highlight on the main thread", why);
      setMode("main");
    },
  );
}

const noGrammar = new Set<string>();

// Bounded by characters rather than entries: one pasted file can outweigh a
// hundred snippets.
const CACHE_CHARS = 4_000_000;
const cache = new Map<string, Answer>();
let cachedChars = 0;
const cacheKey = (form: Form, lang: string, code: string) => `${form}\0${lang}\0${code}`;

function cached(key: string): Answer | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

const size = (key: string, value: Answer) =>
  key.length + (typeof value === "string" ? value.length : value.reduce((n, l) => n + l.length, 0));

function remember(key: string, value: Answer): void {
  if (cache.has(key)) return;
  cache.set(key, value);
  cachedChars += size(key, value);
  for (const [old, held] of cache) {
    if (cachedChars <= CACHE_CHARS) break;
    cache.delete(old);
    cachedChars -= size(old, held);
  }
}

// The text typed since the last answer goes on plain, so a streaming block is
// always current and only its colour lags.
function extend(last: Answer, tail: string): Answer {
  if (typeof last === "string") return last + escapeHtml(tail);
  const [first, ...rest] = tail.split("\n");
  const lines = last.length ? [...last] : [""];
  lines[lines.length - 1] += escapeHtml(first);
  return [...lines, ...rest.map(escapeHtml)];
}

let blocks = 0;

/**
 * The colours for one block, or several blocks one component owns (`slot`
 * tells them apart). Call it in a component: it lives as long as the owner.
 *
 * Null for a block over `HIGHLIGHT_MAX`, a language with no grammar, a block
 * whose grammar failed, or before the first reply. While a newer request is
 * out, a block whose text extends the last answered text shows that answer
 * plus the rest plain. `lines` answers one string of HTML per line, for a body
 * that puts a gutter or a diff marker beside the code; the block is still
 * tokenized whole, so a comment spanning lines stays one thing.
 */
export function createHighlight() {
  const id = ++blocks;
  const [tick, setTick] = createSignal(0);
  const last = new Map<string, { code: string; lang: string; value: Answer }>();
  const asked = new Set<string>();
  const failed = new Set<string>();
  onCleanup(() => asked.forEach(queue.cancel));

  const done = (slot: string) => (req: Request, reply: Reply) => {
    if (reply.value !== undefined) {
      remember(cacheKey(req.form, req.lang, req.code), reply.value);
      last.set(slot, { code: req.code, lang: req.lang, value: reply.value });
    } else if (reply.none) {
      noGrammar.add(req.lang);
    } else {
      failed.add(slot);
    }
    setTick((n) => n + 1);
  };

  function read(form: Form, code: string, lang: string, at: string): Answer | null {
    tick();
    if (code.length > HIGHLIGHT_MAX) return null;
    const name = lang.trim().toLowerCase();
    if (!name) return null;
    if (mode() === "off") start();
    if (mode() === "main") return onMain(form, code, name);
    const slot = `${id}:${form}:${at}`;
    if (noGrammar.has(name) || failed.has(slot)) return null;
    const hit = cached(cacheKey(form, name, code));
    if (hit !== undefined) return hit;
    asked.add(slot);
    queue.request(slot, code, name, form, done(slot));
    const prev = last.get(slot);
    if (prev && prev.lang === name && code.startsWith(prev.code)) return extend(prev.value, code.slice(prev.code.length));
    return null;
  }

  return {
    html: (code: string, lang: string, slot = "") => read("html", code, lang, slot) as string | null,
    lines: (code: string, lang: string, slot = "") => read("lines", code, lang, slot) as string[] | null,
  };
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

// The main-thread engine: the fallback when the worker cannot start, and the
// only path where there is no Worker (tests).
const [version, setVersion] = createSignal(0);
let engine: Engine | null = null;
let engineRequested = false;
const requestedLangs = new Set<string>();

const bump = () => setVersion((v) => v + 1);

function onMain(form: Form, code: string, name: string): Answer | null {
  version();
  if (!ready(name)) return null;
  return form === "lines" ? engine!.toLines(code, name) : engine!.toHtml(code, name);
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
