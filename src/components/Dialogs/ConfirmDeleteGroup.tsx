import { createSignal, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";

// One direct child of the group folder, as returned by `group_delete_preview`.
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

// A GitHub-style destructive confirmation for deleting a group. It shows the full
// blast radius (every child entry, not just discovered projects), the at-risk
// flags, running agents, and total size, and only enables Delete once the exact
// group name is typed. Reuses the shared `.modal-*` chrome + `.danger` styling.
export default function ConfirmDeleteGroup(props: {
  groupName: string;
  entries: DeleteEntry[];
  loading: boolean;
  runningCount: number;
  sizeBytes: number | null;
  // Optional copy overrides so the same dialog serves a plain folder, not only a
  // group (defaults keep the group wording).
  title?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal("");
  const matches = () => value() === props.groupName;
  let input: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => input?.focus()));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches()) props.onConfirm();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={`${styles.modal} ${styles.modalDanger}`} onMouseDown={(e) => e.stopPropagation()}>
          <div class={styles.modalTitle}>{props.title ?? `Delete group “${props.groupName}”?`}</div>
          <div class={styles.modalWarn}>
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
              fallback={<div class={styles.delEmpty}>No contents (empty group)</div>}
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

          <div class={styles.modalLabel}>
            Type <strong>{props.groupName}</strong> to confirm
          </div>
          <input
            ref={input}
            class={styles.modalInput}
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!matches()} onClick={() => props.onConfirm()}>
              {props.confirmLabel ?? "Delete group"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
