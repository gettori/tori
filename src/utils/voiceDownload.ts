import type { OpenJob } from "./events";
import { createDownload, type DownloadStatus, type SizeChoice } from "./modelDownload";

export { mb } from "./modelDownload";

export type VoiceSize = "int8" | "full" | "fast";

export const SIZES: SizeChoice<VoiceSize>[] = [
  {
    id: "int8",
    label: "Smaller",
    description: "The natural voice. Sounds nearly the same as Larger, and 28 voices to pick from.",
  },
  { id: "full", label: "Larger", description: "The natural voice at full quality. The same 28 voices." },
  { id: "fast", label: "Fastest", description: "Starts quickest. Eight voices, and a little less natural." },
];

export type SpeechStatus = DownloadStatus<VoiceSize> & { espeak: boolean; brew: boolean };

export const voiceDownloads = createDownload<VoiceSize, SpeechStatus>({
  command: "speech",
  event: "speech-download",
  sizes: SIZES,
  empty: { installed: false, model: null, downloading: null, sizes: [], espeak: false, brew: false },
});

export const {
  status,
  asking,
  failed,
  refresh,
  askToDownload,
  dismissAsk,
  dropPending,
  download,
  cancelDownload,
  sizeLabel,
} = voiceDownloads;
export const deleteVoice = voiceDownloads.remove;

export const defaultVoice = () =>
  status().model === "fast" ? { id: "expr-voice-2-f", name: "Bella" } : { id: "af_heart", name: "Heart" };

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
