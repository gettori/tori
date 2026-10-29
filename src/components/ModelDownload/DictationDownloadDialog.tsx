import ModelDownloadDialog, { type Copy } from "./ModelDownloadDialog";
import { dictationDownloads } from "../../utils/dictationDownload";

const COPY: Copy = {
  title: "Download a dictation model",
  intro:
    "Dictation turns what you say into text with a model that runs on this Mac. Pick one to download. Your voice " +
    "never leaves the Mac, and you can change the model later in Settings.",
  pick: "Dictation model",
  failed: "Couldn't download the dictation model",
};

export default function DictationDownloadDialog() {
  return <ModelDownloadDialog store={dictationDownloads} copy={COPY} />;
}
