// Lexing for the markdown preview. A small document lexes on the spot; a large
// one goes to a worker, because one pass over a megabyte held a frame for 90ms
// and the lexer cannot be cut into pieces (reference links are document-wide).
import { marked, type Token } from "marked";
import { traceWork } from "../../utils/perfTrace";
import { startWorker } from "../../utils/startWorker";

// Under this the lex is a millisecond or two, less than a round trip.
const WORKER_FROM = 64 * 1024;
// A megabyte lexes in about 90ms, so a worker silent for this long is hung,
// and every request behind it would hang too.
const ANSWER_MS = 10_000;

type Waiter = { resolve: (tokens: Token[]) => void; text: string; timer: ReturnType<typeof setTimeout> };

let worker: Worker | null = null;
let mode: "off" | "worker" | "main" = "off";
let nextId = 0;
const waiting = new Map<number, Waiter>();

const onMain = (text: string) => traceWork("md-preview", () => marked.lexer(text));

function fallBack(why: unknown): void {
  if (mode === "main") return;
  console.warn("[preview] the markdown worker failed; large files will lex on the main thread", why);
  worker?.terminate();
  worker = null;
  mode = "main";
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.resolve(onMain(w.text));
  }
  waiting.clear();
}

function start(): void {
  // No Worker at all is the test environment, not a failure worth a warning.
  if (typeof Worker === "undefined") return void (mode = "main");
  mode = "worker";
  worker = startWorker(
    () => new Worker(new URL("./markedWorker.ts", import.meta.url), { type: "module" }),
    (data) => {
      const { id, tokens, error } = data as { id: number; tokens?: Token[]; error?: string };
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      clearTimeout(w.timer);
      // A document the worker could not lex is lexed here, so it still shows.
      w.resolve(error ? onMain(w.text) : tokens!);
    },
    fallBack,
  );
}

/** The tokens of `text`, synchronously when it is small. */
export function lexPreview(text: string): Token[] | Promise<Token[]> {
  if (text.length < WORKER_FROM) return onMain(text);
  if (mode === "off") start();
  if (mode === "main") return onMain(text);
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => fallBack("no answer in time"), ANSWER_MS);
    waiting.set(id, { resolve, text, timer });
    worker!.postMessage({ id, text });
  });
}
