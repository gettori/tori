// Every plugin call runs on one chain, in the order asked: a Stop pressed while
// a reply is still being queued must not reach the engine ahead of chunks
// queued before it, or those would speak after it.
import { createSignal } from "solid-js";
import {
  MAX_TEXT_LENGTH,
  isTtsError,
  onSpeechEvent,
  speak,
  stop as stopEngine,
  type SpeechEvent,
} from "tauri-plugin-tts-api";
import { emitWith, TOAST, type ToastEvent } from "./events";

export type Chunk = { text: string; block?: number };

export type Reading = { source: string; block: number | undefined };

const [reading, setReading] = createSignal<Reading | null>(null);
export { reading };

let generation = 0;
let chain: Promise<unknown> = Promise.resolve();
let parts: Chunk[] = [];
let source = "";
const utterances = new Map<string, number>();
let listening: Promise<void> | null = null;

function enqueue(op: () => Promise<unknown>) {
  chain = chain.then(op, op);
  return chain;
}

function settle() {
  generation += 1;
  parts = [];
  utterances.clear();
  setReading(null);
}

function fail(e: unknown) {
  settle();
  const message = isTtsError(e) ? e.message : String(e);
  emitWith<ToastEvent>(TOAST, { message: `Couldn't read aloud: ${message}`, kind: "error" });
}

function listen() {
  listening ??= Promise.all([
    onSpeechEvent("speech:start", (e: SpeechEvent) => {
      const at = e.id ? utterances.get(e.id) : undefined;
      if (at !== undefined) setReading({ source, block: parts[at]?.block });
    }),
    onSpeechEvent("speech:finish", (e: SpeechEvent) => {
      if (e.id && utterances.get(e.id) === parts.length - 1) settle();
    }),
    // A cancel of one of ours that this module did not ask for: another speak
    // flushed the queue, such as a voice preview.
    onSpeechEvent("speech:cancel", (e: SpeechEvent) => {
      if (e.id && utterances.has(e.id)) settle();
    }),
    onSpeechEvent("speech:error", (e: SpeechEvent) => {
      if (e.id && utterances.has(e.id)) fail(e.error ?? "speech engine error");
    }),
  ]).then(
    () => {},
    (e) => {
      listening = null;
      throw e;
    },
  );
  return listening;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function hardSplit(text: string, cap: number): string[] {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of text) {
    const n = bytes(ch);
    if (size + n > cap) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

export function splitToFit(text: string, cap = MAX_TEXT_LENGTH): string[] {
  if (bytes(text) <= cap) return [text];
  const sentences = text.match(/[^.!?\u0964]+[.!?\u0964]*\s*|[.!?\u0964]+\s*/g) ?? [text];
  const pieces = sentences.flatMap((s) =>
    bytes(s) <= cap ? [s] : (s.match(/\S+\s*|\s+/g) ?? [s]).flatMap((w) => (bytes(w) <= cap ? [w] : hardSplit(w, cap))),
  );
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && bytes(cur + p) > cap) {
      out.push(cur);
      cur = "";
    }
    cur += p;
  }
  if (cur) out.push(cur);
  return out;
}

export function read(chunks: Chunk[], from: string): Promise<unknown> {
  const next = chunks
    .flatMap((c) => splitToFit(c.text).map((text) => ({ text, block: c.block })))
    .filter((c) => c.text.trim());
  if (!next.length) return stop();
  settle();
  const mine = generation;
  parts = next;
  source = from;
  setReading({ source, block: next[0].block });
  // All queued now rather than from finish events, so Stop has nothing of
  // ours left to race.
  return enqueue(async () => {
    try {
      await listen();
      for (const [i, part] of next.entries()) {
        if (mine !== generation) return;
        const res = await speak({ text: part.text, queueMode: i === 0 ? "flush" : "add" });
        if (res.utteranceId && mine === generation) utterances.set(res.utteranceId, i);
      }
    } catch (e) {
      if (mine === generation) fail(e);
    }
  });
}

export function stop(): Promise<unknown> {
  settle();
  return enqueue(() => stopEngine().catch(fail));
}

// For speech left over from before a reload. Nobody pressed anything, so an
// engine that cannot stop has nobody to tell.
export function reset(): Promise<unknown> {
  settle();
  return enqueue(() => stopEngine().catch(() => {}));
}
