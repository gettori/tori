import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { askToDownload } from "./dictationDownload";

export type DictationState = "idle" | "recording" | "transcribing";

type DictationError = { kind: "notDownloaded" } | { kind: "permission" } | { kind: "failed"; error: string };
type Transcript = { kind: "silent" } | { kind: "text"; text: string };

export const PERMISSION_HELP =
  "Tori isn't getting sound from the microphone. Allow it under System Settings, Privacy & Security, Microphone.";

// How long a recording may hear nothing but exact zeros before it is taken
// for a microphone macOS is withholding.
const WITHHELD_AFTER = 1500;

export const BARS = 32;
const silent = () => Array<number>(BARS).fill(0);

const [state, setState] = createSignal<DictationState>("idle");
const [levels, setLevels] = createSignal<number[]>(silent());
export { state, levels };

let listening: Promise<unknown> | null = null;
let heardSound = false;
let withheldCheck: ReturnType<typeof setTimeout> | null = null;

// RMS to a bar height: -50 dB is the floor of a quiet room, -10 dB a voice
// close to the mic.
export const height = (rms: number) => Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-9) + 50) / 40));

function hear() {
  listening ??= listen<number>("dictation-level", (e) => {
    if (state() !== "recording") return;
    if (e.payload > 0) heardSound = true;
    setLevels((l) => [...l.slice(1), height(e.payload)]);
  }).catch((e) => {
    listening = null;
    throw e;
  });
  return listening;
}

// Bumped by every stop and every drop, so a stop that was dropped while in
// flight inserts nothing even when a newer stop is under way.
let run = 0;

export async function toggle(insert: (text: string) => void): Promise<void> {
  if (state() === "transcribing") return;
  if (state() === "recording") return finish(insert);
  try {
    await hear();
    await invoke("dictation_start");
  } catch (e) {
    return fail(e, "start dictating");
  }
  setLevels(silent());
  heardSound = false;
  setState("recording");
  withheldCheck = setTimeout(() => {
    if (state() !== "recording" || heardSound) return;
    dropActive();
    emitWith<ToastEvent>(TOAST, { message: PERMISSION_HELP, kind: "error" });
  }, WITHHELD_AFTER);
}

function clearWithheldCheck() {
  if (withheldCheck) clearTimeout(withheldCheck);
  withheldCheck = null;
}

async function finish(insert: (text: string) => void): Promise<void> {
  clearWithheldCheck();
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
  clearWithheldCheck();
  if (state() === "idle") return false;
  if (state() === "recording") void invoke("dictation_cancel").catch((e) => fail(e, "stop the microphone"));
  run += 1;
  setState("idle");
  return true;
}

function fail(e: unknown, what: string) {
  const known = e && typeof e === "object" && "kind" in e ? (e as DictationError) : null;
  if (known?.kind === "notDownloaded") return askToDownload();
  const message =
    known?.kind === "permission" ? PERMISSION_HELP : `Couldn't ${what}: ${known ? known.error : String(e)}`;
  emitWith<ToastEvent>(TOAST, { message, kind: "error" });
}
