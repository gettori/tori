import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { askToDownload } from "./dictationDownload";

export type DictationState = "idle" | "recording" | "transcribing";

type DictationError = { kind: "notDownloaded" } | { kind: "permission" } | { kind: "failed"; error: string };
type Transcript = { kind: "silent" } | { kind: "text"; text: string };

export const PERMISSION_HELP =
  "Tori can't use the microphone. Allow it under System Settings, Privacy & Security, Microphone.";

const [state, setState] = createSignal<DictationState>("idle");
const [seconds, setSeconds] = createSignal(0);
export { state, seconds };

let clock: ReturnType<typeof setInterval> | null = null;
// Bumped by every stop and every drop, so a stop that was dropped while in
// flight inserts nothing even when a newer stop is under way.
let run = 0;

export const clockLabel = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export async function toggle(insert: (text: string) => void): Promise<void> {
  if (state() === "transcribing") return;
  if (state() === "recording") return finish(insert);
  try {
    await invoke("dictation_start");
  } catch (e) {
    return fail(e, "start dictating");
  }
  const started = Date.now();
  setSeconds(0);
  setState("recording");
  clock = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
}

async function finish(insert: (text: string) => void): Promise<void> {
  stopClock();
  setState("transcribing");
  const mine = ++run;
  try {
    const said = await invoke<Transcript>("dictation_stop");
    if (mine !== run) return;
    if (said.kind === "text" && said.text.trim()) insert(said.text.trim());
  } catch (e) {
    if (mine === run) fail(e, "transcribe");
  } finally {
    if (mine === run) setState("idle");
  }
}

export function dropActive(): boolean {
  if (state() === "idle") return false;
  if (state() === "recording") {
    stopClock();
    void invoke("dictation_cancel").catch((e) => fail(e, "stop the microphone"));
  }
  run += 1;
  setState("idle");
  return true;
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = null;
}

function fail(e: unknown, what: string) {
  const known = e && typeof e === "object" && "kind" in e ? (e as DictationError) : null;
  if (known?.kind === "notDownloaded") return askToDownload();
  const message =
    known?.kind === "permission" ? PERMISSION_HELP : `Couldn't ${what}: ${known ? known.error : String(e)}`;
  emitWith<ToastEvent>(TOAST, { message, kind: "error" });
}
