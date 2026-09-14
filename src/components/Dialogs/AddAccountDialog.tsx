import { createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// Enter is handled on the wrapper so it submits from either field. Escape is
// already `Dialog`'s `onClose`, and a second handler would cancel twice.
const NAME_LABEL = "add-account-name-label";
const FOLDER_LABEL = "add-account-folder-label";

export default function AddAccountDialog(props: {
  agentLabel: string;
  onSubmit: (answer: { label: string; folder: string }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const submit = () => props.onSubmit({ label: label(), folder: folder() });
  let first: HTMLInputElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  }

  return (
    <Dialog
      open
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
      <div onKeyDown={onKeyDown}>
        <div id={NAME_LABEL} class={styles.label}>
          Name
        </div>
        <input
          ref={first}
          class={styles.input}
          aria-labelledby={NAME_LABEL}
          value={label()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        <div class={styles.msg}>Sway's own label for it. The agent never sees this.</div>

        <div id={FOLDER_LABEL} class={styles.label}>
          Folder
        </div>
        <input
          class={styles.input}
          aria-labelledby={FOLDER_LABEL}
          value={folder()}
          placeholder="Leave empty for a folder Sway manages"
          onInput={(e) => setFolder(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <div class={styles.msg}>
          {props.agentLabel} keys its login by this exact spelling, so write it the way your shell
          exports it.
        </div>
      </div>
    </Dialog>
  );
}
