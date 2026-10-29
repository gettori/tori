import { createDownload, type DownloadStatus, type SizeChoice } from "./modelDownload";

export type DictationSize = "moonshine" | "parakeet";

// Parakeet is CC BY 4.0, so the credit goes wherever the model is offered or shown.
export const CREDIT = "Parakeet by NVIDIA, CC BY 4.0";

export const SIZES: SizeChoice<DictationSize>[] = [
  {
    id: "moonshine",
    label: "Moonshine",
    description: "Small and quick. Good for a sentence or a paragraph at a time.",
  },
  { id: "parakeet", label: "Parakeet", description: `More accurate, and ten times the download. ${CREDIT}.` },
];

export type DictationStatus = DownloadStatus<DictationSize>;

export const dictationDownloads = createDownload<DictationSize, DictationStatus>({
  command: "dictation",
  event: "dictation-download",
  sizes: SIZES,
  empty: { installed: false, model: null, downloading: null, sizes: [] },
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
} = dictationDownloads;
export const deleteModel = dictationDownloads.remove;
