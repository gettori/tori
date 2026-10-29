import ModelDownloadDialog, { type Copy } from "./ModelDownloadDialog";
import { voiceDownloads } from "../../utils/voiceDownload";

const COPY: Copy = {
  title: "Download a voice",
  intro:
    "Read aloud speaks with a voice that runs on this Mac. Pick one to download. The text it reads never leaves the " +
    "Mac, and you can change the voice later in Settings.",
  pick: "Voice model",
  failed: "Couldn't download the voice",
};

export default function VoiceDownloadDialog() {
  return <ModelDownloadDialog store={voiceDownloads} copy={COPY} />;
}
