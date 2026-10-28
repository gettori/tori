// Every engine call runs on one chain, in the order asked: a Stop pressed while
// a read is still being handed over must not reach the engine ahead of it, or
// that read would speak after the Stop.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen as listenTo } from "@tauri-apps/api/event";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { saveSettings, settings } from "../panels/Settings/settingsStore";

type SpeechEvent =
  | { kind: "start"; read: number; chunk: number }
  | { kind: "finish"; read: number; chunk: number }
  | { kind: "cancel"; read: number }
  | { kind: "error"; read: number; error: string };

export type Voice = { id: string; name: string; language: string };

export const DEFAULT_VOICE = "af_heart";

export type Chunk = { text: string; block?: number };

export type Reading = { source: string; block: number | undefined };

const [reading, setReading] = createSignal<Reading | null>(null);
export { reading };

const [frontReply, setFrontReply] = createSignal<(() => void) | null>(null);
export { frontReply };

export function offerLastReply(readLast: () => void): () => void {
  setFrontReply(() => readLast);
  return () => setFrontReply((now) => (now === readLast ? null : now));
}

export function readingBlockOf(from: string): number | undefined {
  const now = reading();
  return now?.source === from ? now.block : undefined;
}

let generation = 0;
let chain: Promise<unknown> = Promise.resolve();
let parts: Chunk[] = [];
let source = "";
let current = 0;
let offset = 0;
let readId: number | null = null;
// The engine can answer before the command that started the read returns.
let held: SpeechEvent[] | null = null;
let listening: Promise<void> | null = null;

function enqueue(op: () => Promise<unknown>) {
  chain = chain.then(op, op);
  return chain;
}

function settle() {
  generation += 1;
  parts = [];
  readId = null;
  setReading(null);
}

function fail(e: unknown, what = "read aloud") {
  settle();
  emitWith<ToastEvent>(TOAST, { message: `Couldn't ${what}: ${String(e)}`, kind: "error" });
}

function heard(e: SpeechEvent) {
  if (held) {
    held.push(e);
    return;
  }
  if (e.read !== readId) return;
  if (e.kind === "start") {
    current = offset + e.chunk;
    setReading({ source, block: parts[current]?.block });
  } else if (e.kind === "finish") {
    if (offset + e.chunk === parts.length - 1) settle();
  } else if (e.kind === "cancel") {
    // Stopped from the Rust side, which happens when the window closes.
    settle();
  } else {
    fail(e.error);
  }
}

function listen() {
  listening ??= listenTo<SpeechEvent>("speech", (e) => heard(e.payload)).then(
    () => {},
    (e) => {
      listening = null;
      throw e;
    },
  );
  return listening;
}

export const voices = () => invoke<Voice[]>("speech_voices");

export function read(chunks: Chunk[], from: string): Promise<unknown> {
  const next = chunks.filter((c) => c.text.trim());
  if (!next.length) return stop();
  return start(next, from, 0, settings.speech.rate);
}

function start(next: Chunk[], from: string, at: number, rate: number): Promise<unknown> {
  settle();
  const mine = generation;
  parts = next;
  source = from;
  current = at;
  offset = at;
  setReading({ source, block: next[at].block });
  return enqueue(async () => {
    try {
      await listen();
      held = [];
      const id = await invoke<number>("speech_speak", {
        chunks: next.slice(at).map((c) => c.text),
        rate,
        voice: settings.speech.voice,
      });
      const early = held;
      held = null;
      if (mine !== generation) return;
      readId = id;
      early.forEach(heard);
    } catch (e) {
      held = null;
      if (mine === generation) fail(e);
    }
  });
}

// The rate goes out with the read, so a new one only takes effect by reading
// again, from the chunk being spoken now.
export function changeRate(rate: number): Promise<unknown> {
  void saveSettings({ ...settings, speech: { ...settings.speech, rate } }).catch(fail);
  return parts.length ? start(parts, source, current, rate) : Promise.resolve();
}

export function readSelection(text: string): Promise<unknown> {
  return read(
    text.split(/\n\s*\n/).map((t) => ({ text: t.trim() })),
    "selection",
  );
}

export function preview(voice: string | null, text: string): Promise<unknown> {
  settle();
  return enqueue(() =>
    invoke("speech_speak", { chunks: [text], rate: settings.speech.rate, voice }).catch((e) =>
      fail(e, "play the voice"),
    ),
  );
}

export function stop(): Promise<unknown> {
  settle();
  return enqueue(() => invoke("speech_stop").catch(fail));
}

// For speech left over from before a reload. Nobody pressed anything, so an
// engine that cannot stop has nobody to tell.
export function reset(): Promise<unknown> {
  settle();
  return enqueue(() => invoke("speech_stop").catch(() => {}));
}
