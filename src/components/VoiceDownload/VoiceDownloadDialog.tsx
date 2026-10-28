import { Show, createSignal } from "solid-js";
import styles from "../Dialogs/Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import RadioGroup from "../RadioGroup/RadioGroup";
import {
  SIZES,
  asking,
  cancelDownload,
  closeDialog,
  download,
  failed,
  mb,
  sizeLabel,
  status,
  type VoiceSize,
} from "../../utils/voiceDownload";

export default function VoiceDownloadDialog() {
  return (
    <Show when={asking()}>
      <Ask />
    </Show>
  );
}

function Ask() {
  const [size, setSize] = createSignal<VoiceSize>(status().model === "int8" ? "full" : "int8");
  const running = () => status().downloading;
  return (
    <Dialog
      open
      title="Download a voice"
      onClose={closeDialog}
      actions={
        <Show
          when={running()}
          fallback={
            <>
              <Button onClick={closeDialog}>Not now</Button>
              <Button variant="primary" onClick={() => void download(size())}>
                {failed() ? "Retry" : "Download"}
              </Button>
            </>
          }
        >
          <Button onClick={() => void cancelDownload()}>Cancel download</Button>
          <Button onClick={closeDialog}>Close</Button>
        </Show>
      }
    >
      <div class={styles.msg}>
        Read aloud speaks with a voice that runs on this Mac. It downloads once, and the text never leaves the Mac.
      </div>
      <Show
        when={running()}
        fallback={
          <RadioGroup
            aria-label="Voice size"
            value={size()}
            onChange={(v) => setSize(v as VoiceSize)}
            options={SIZES.map((s) => ({ value: s.id, label: sizeLabel(s.id), description: s.description }))}
          />
        }
      >
        {(p) => (
          <div class={styles.msg} role="status">
            Downloading, {mb(p().done)} of {mb(p().total)} MB
          </div>
        )}
      </Show>
      <Show when={failed()}>
        {(error) => (
          <div class={styles.msg} role="alert">
            Couldn't download the voice: {error()}
          </div>
        )}
      </Show>
    </Dialog>
  );
}
