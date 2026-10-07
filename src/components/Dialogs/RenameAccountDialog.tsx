import { Show, createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";

const NAME_LABEL = "rename-account-name-label";

/** Mirrors `crate::account_commands::command_slug`, for the preview only: the
 *  backend computes the command it stores. */
export function commandSlug(program: string, label: string, profileId: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${program}-${slug || profileId.replace(/_/g, "-")}`;
}

export default function RenameAccountDialog(props: {
  label: string;
  profileId: string;
  program: string;
  command: string | null;
  onSubmit: (answer: { label: string; renameCommand: boolean }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = createSignal(props.label);
  const [follow, setFollow] = createSignal(true);
  const next = () => commandSlug(props.program, label().trim(), props.profileId);
  const offered = () => props.command !== null && label().trim() !== "" && next() !== props.command;
  const submit = () => props.onSubmit({ label: label(), renameCommand: offered() && follow() });
  let field: HTMLInputElement | undefined;

  return (
    <Dialog
      open
      class={styles.tallControls}
      title={`Rename ${props.label}`}
      onClose={() => props.onCancel()}
      initialFocus={() => field}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()}>
            Rename
          </Button>
        </>
      }
    >
      <div class={styles.form}>
        <div class={styles.field}>
          <div id={NAME_LABEL} class={styles.fieldLabel}>
            Name
          </div>
          <input
            ref={(el) => {
              field = el;
              queueMicrotask(() => el.select());
            }}
            class={styles.fieldInput}
            aria-labelledby={NAME_LABEL}
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              submit();
            }}
          />
        </div>
        <Show when={offered()}>
          <Checkbox checked={follow()} onChange={setFollow} label={`Also rename command to ${next()}`} />
          <div class={styles.optionHint}>
            {follow()
              ? `${props.command} stops working, so update any script that calls it.`
              : `The account keeps running as ${props.command}.`}
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
