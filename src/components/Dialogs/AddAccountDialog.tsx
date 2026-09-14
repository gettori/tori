import { Show, createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// Enter is handled on the wrapper so it submits from either field. Escape is
// already `Dialog`'s `onClose`, and a second handler would cancel twice.
const NAME_LABEL = "add-account-name-label";
const FOLDER_LABEL = "add-account-folder-label";

export default function AddAccountDialog(props: {
  agentLabel: string;
  browse?: (from: string) => Promise<string | null>;
  onSubmit: (answer: { label: string; folder: string }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const submit = () => props.onSubmit({ label: label(), folder: folder() });
  let first: HTMLInputElement | undefined;

  const [picking, setPicking] = createSignal(false);
  const browse = async () => {
    setPicking(true);
    try {
      const chosen = await props.browse?.(folder());
      if (chosen) setFolder(chosen);
    } finally {
      setPicking(false);
    }
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    submit();
  }

  return (
    <Dialog
      open
      class={styles.tallControls}
      title={`New ${props.agentLabel} account`}
      onClose={() => props.onCancel()}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()}>
            {folder().trim() ? "Add account" : "Create and sign in"}
          </Button>
        </>
      }
    >
      <div class={styles.form} onKeyDown={onKeyDown}>
        <div class={styles.field}>
          <div id={NAME_LABEL} class={styles.fieldLabel}>
            Name
          </div>
          <input
            ref={first}
            class={styles.fieldInput}
            aria-labelledby={NAME_LABEL}
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
          <div class={styles.fieldHint}>Sway's own label for it. The agent never sees this.</div>
        </div>

        <div class={styles.field}>
          <div id={FOLDER_LABEL} class={styles.fieldLabel}>
            Folder
          </div>
          <div class={styles.fieldRow}>
            <input
              class={styles.fieldInput}
              aria-labelledby={FOLDER_LABEL}
              value={folder()}
              placeholder="Leave empty for a folder Sway manages"
              onInput={(e) => setFolder(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
            <Show when={props.browse}>
              <Button disabled={picking()} onClick={() => void browse()}>
                Browse
              </Button>
            </Show>
          </div>
          <div class={styles.fieldHint}>
            {props.agentLabel} keys its login by this exact spelling, so write it the way your shell
            exports it.
          </div>
        </div>
      </div>
    </Dialog>
  );
}
