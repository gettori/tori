import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OpenJob } from "./events";

export type VoiceSize = "int8" | "full" | "fast";

export const SIZES: { id: VoiceSize; label: string; description: string }[] = [
  {
    id: "int8",
    label: "Smaller",
    description: "The natural voice. Sounds nearly the same as Larger, and 28 voices to pick from.",
  },
  { id: "full", label: "Larger", description: "The natural voice at full quality. The same 28 voices." },
  { id: "fast", label: "Fastest", description: "Starts quickest. Eight voices, and a little less natural." },
];

export const defaultVoice = () =>
  status().model === "fast" ? { id: "expr-voice-2-f", name: "Bella" } : { id: "af_heart", name: "Heart" };

export type Progress = { size: VoiceSize; done: number; total: number };

export type SpeechStatus = {
  installed: boolean;
  model: VoiceSize | null;
  downloading: Progress | null;
  sizes: { id: VoiceSize; bytes: number }[];
  espeak: boolean;
  brew: boolean;
};

type DownloadEvent =
  | ({ kind: "progress" } & Progress)
  | { kind: "done"; size: VoiceSize }
  | { kind: "cancel" }
  | { kind: "error"; error: string };

const [status, setStatus] = createSignal<SpeechStatus>({
  installed: false,
  model: null,
  downloading: null,
  sizes: [],
  espeak: false,
  brew: false,
});
const [asking, setAsking] = createSignal(false);
const [failed, setFailed] = createSignal<string | null>(null);
export { status, asking, failed };

let pending: (() => void) | null = null;
let listening: Promise<unknown> | null = null;

function heard(e: DownloadEvent) {
  if (e.kind === "progress") {
    setStatus({ ...status(), downloading: { size: e.size, done: e.done, total: e.total } });
    return;
  }
  setStatus({ ...status(), downloading: null });
  if (e.kind === "error") setFailed(e.error);
  void refresh().catch((err) => setFailed(String(err)));
  if (e.kind !== "done") return;
  const read = pending;
  pending = null;
  setAsking(false);
  read?.();
}

function watch() {
  listening ??= listen<DownloadEvent>("speech-download", (e) => heard(e.payload)).catch((e) => {
    listening = null;
    throw e;
  });
  return listening;
}

export async function refresh(): Promise<void> {
  await watch();
  setStatus(await invoke<SpeechStatus>("speech_status"));
}

export function askToDownload(then: (() => void) | null = null): void {
  pending = then;
  setFailed(null);
  setAsking(true);
  void refresh().catch((e) => setFailed(String(e)));
}

// Closing keeps the download going: only the read waiting on it is dropped.
export function closeDialog(): void {
  pending = null;
  setAsking(false);
}

export function dropPending(): void {
  pending = null;
}

export async function download(size: VoiceSize): Promise<void> {
  setFailed(null);
  try {
    await watch();
    await invoke("speech_download", { size });
    await refresh();
  } catch (e) {
    setFailed(String(e));
  }
}

export const mb = (bytes: number) => Math.round(bytes / 1e6);

export function sizeLabel(id: VoiceSize): string {
  const size = SIZES.find((s) => s.id === id)!;
  const bytes = status().sizes.find((s) => s.id === id)?.bytes;
  return bytes ? `${size.label}, ${mb(bytes)} MB` : size.label;
}

export function espeakJob(verb: "install" | "uninstall", cwd: string): OpenJob {
  return {
    id: `${verb}:espeak-ng`,
    title: `${verb === "install" ? "Install" : "Uninstall"} espeak-ng`,
    cwd,
    program: "brew",
    args: [verb, "espeak-ng"],
    interactive: true,
    recheckSpeechOnExit: true,
  };
}

export const cancelDownload = () => invoke("speech_download_cancel");

export async function deleteVoice(): Promise<void> {
  await invoke("speech_delete");
  await refresh();
}
