import { createSignal, For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// The visible "Type <name> to confirm" line is also the field's accessible name
// (the `aria-labelledby` convention `NewProjectDialog` set in #99), so the two
// cannot drift apart. Static id: only one of these can be open at a time.
const CONFIRM_LABEL = "confirm-delete-space-label";

// One direct child of the space folder, as returned by `space_delete_preview`.
export type DeleteEntry = {
  name: string;
  kind: "repo" | "folder" | "file";
  dirty: boolean;
  unpushed: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// A GitHub-style destructive confirmation for deleting a space. It shows the full
// blast radius (every child entry, not just discovered projects), the at-risk
// flags, running agents, and total size, and only enables Delete once the exact
// space name is typed.
//
// The shell is `Dialog`, at the `sheet` width the old danger-dialog rule spelled
// out. Enter stays on the **input**, deliberately not on the panel as its
// siblings in this set do: the gate is a field, and answering the key from
// anywhere in the dialog would widen it to the whole surface. Escape is
// Kobalte's, reported as `onClose`.
export default function ConfirmDeleteSpace(props: {
  spaceName: string;
  entries: DeleteEntry[];
  loading: boolean;
  runningCount: number;
  sizeBytes: number | null;
  // Optional copy overrides so the same dialog serves a plain folder, not only a
  // space (defaults keep the space wording).
  title?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal("");
  const matches = () => value() === props.spaceName;
  let input: HTMLInputElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (matches()) props.onConfirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={props.title ?? `Delete space “${props.spaceName}”?`}
      onClose={() => props.onCancel()}
      initialFocus={() => input}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="danger" disabled={!matches()} onClick={() => props.onConfirm()}>
            {props.confirmLabel ?? "Delete space"}
          </Button>
        </>
      }
    >
      <div class={styles.warning}>
        This permanently deletes the folder and everything below. It cannot be undone.
      </div>

      <div class={styles.delSummary}>
        <span>{props.runningCount} agent{props.runningCount === 1 ? "" : "s"} running here</span>
        <span>
          {props.sizeBytes === null ? "calculating size…" : formatBytes(props.sizeBytes)}
        </span>
      </div>

      <div class={styles.delEntries}>
        <Show
          when={props.entries.length}
          fallback={<div class={styles.delEmpty}>No contents (empty space)</div>}
        >
          <For each={props.entries}>
            {(e) => (
              <div class={styles.delEntry}>
                <span class={styles.delEntryName}>{e.name}</span>
                <span class={styles.delEntryTags}>
                  <Show when={e.kind === "repo"} fallback={<span class={`${styles.delTag} ${styles.muted}`}>{e.kind}</span>}>
                    <Show when={props.loading}>
                      <span class={`${styles.delTag} ${styles.muted}`}>checking…</span>
                    </Show>
                    <Show when={!props.loading && e.dirty}>
                      <span class={`${styles.delTag} ${styles.warn}`}>uncommitted</span>
                    </Show>
                    <Show when={!props.loading && e.unpushed}>
                      <span class={`${styles.delTag} ${styles.warn}`}>unpushed</span>
                    </Show>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div id={CONFIRM_LABEL} class={styles.label}>
        Type <strong>{props.spaceName}</strong> to confirm
      </div>
      <input
        ref={input}
        class={styles.input}
        aria-labelledby={CONFIRM_LABEL}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
      />
    </Dialog>
  );
}
