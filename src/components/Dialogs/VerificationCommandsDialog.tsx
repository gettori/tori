import { createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

const LIST_LABEL = "verification-commands-label";

/**
 * The commands that count as a check in one project, one per line.
 *
 * A saved list replaces the built-in one for this project rather than adding
 * to it, which is why the dialog opens on the list in force: editing it loses
 * nothing, and "Reset to defaults" is the way back.
 */
export default function VerificationCommandsDialog(props: {
  projectName: string;
  commands: string[];
  onSave: (commands: string[]) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = createSignal(props.commands.join("\n"));
  const commands = () =>
    text()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  return (
    <Dialog
      open
      size="sheet"
      title={`Verification commands for ${props.projectName}`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button class={styles.leadAction} onClick={() => props.onReset()}>
            Reset to defaults
          </Button>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!commands().length} onClick={() => props.onSave(commands())}>
            Save
          </Button>
        </>
      }
    >
      <div id={LIST_LABEL} class={styles.label}>
        One command per line
      </div>
      <textarea
        class={`${styles.input} ${styles.commandList}`}
        aria-labelledby={LIST_LABEL}
        rows={12}
        spellcheck={false}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class={styles.hint}>
        A turn that changed code is verified when the last of these it ran after its last edit passed. A command matches
        with any arguments after it, and through wrappers like npx or uv run.
      </div>
    </Dialog>
  );
}
