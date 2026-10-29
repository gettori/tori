import { Show, createSignal } from "solid-js";
import styles from "../Dialogs/Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import RadioGroup from "../RadioGroup/RadioGroup";
import { mb, type DownloadStatus, type DownloadStore, type SizeChoice } from "../../utils/modelDownload";

export type Copy = {
  title: string;
  intro: string;
  pick: string;
  failed: string;
};

export default function ModelDownloadDialog<Id extends string>(props: {
  store: DownloadStore<Id, DownloadStatus<Id>>;
  copy: Copy;
}) {
  return (
    <Show when={props.store.asking()}>
      <Ask store={props.store} copy={props.copy} />
    </Show>
  );
}

const firstNotInstalled = <Id extends string>(sizes: SizeChoice<Id>[], installed: Id | null) =>
  sizes.find((s) => s.id !== installed)?.id ?? sizes[0].id;

function Ask<Id extends string>(props: { store: DownloadStore<Id, DownloadStatus<Id>>; copy: Copy }) {
  const { status, failed, download, cancelDownload, dismissAsk, sizeLabel, sizes } = props.store;
  const [size, setSize] = createSignal<Id>(firstNotInstalled(sizes, status().model));
  const running = () => status().downloading;
  return (
    <Dialog
      open
      title={props.copy.title}
      onClose={dismissAsk}
      actions={
        <Show
          when={running()}
          fallback={
            <>
              <Button onClick={dismissAsk}>Not now</Button>
              <Button variant="primary" onClick={() => void download(size())}>
                {failed() ? "Retry" : "Download"}
              </Button>
            </>
          }
        >
          <Button onClick={() => void cancelDownload()}>Cancel download</Button>
          <Button onClick={dismissAsk}>Close</Button>
        </Show>
      }
    >
      <div class={styles.msg}>{props.copy.intro}</div>
      <Show
        when={running()}
        fallback={
          <RadioGroup
            aria-label={props.copy.pick}
            value={size()}
            onChange={(v) => setSize(() => v as Id)}
            options={sizes.map((s) => ({ value: s.id, label: sizeLabel(s.id), description: s.description }))}
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
            {props.copy.failed}: {error()}
          </div>
        )}
      </Show>
    </Dialog>
  );
}
