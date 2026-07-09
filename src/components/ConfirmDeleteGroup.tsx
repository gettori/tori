import { createSignal, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";

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
      <div class="modal-backdrop" onMouseDown={() => props.onCancel()}>
        <div class="modal modal-danger" onMouseDown={(e) => e.stopPropagation()}>
          <div class="modal-title">Delete group “{props.groupName}”?</div>
          <div class="modal-warn">
            This permanently deletes the folder and everything below. It cannot be undone.
          </div>

          <div class="del-summary">
            <span>{props.runningCount} agent{props.runningCount === 1 ? "" : "s"} running here</span>
            <span>
              {props.sizeBytes === null ? "calculating size…" : formatBytes(props.sizeBytes)}
            </span>
          </div>

          <div class="del-entries">
            <Show
              when={props.entries.length}
              fallback={<div class="del-empty">No contents (empty group)</div>}
            >
              <For each={props.entries}>
                {(e) => (
                  <div class="del-entry">
                    <span class="del-entry-name">{e.name}</span>
                    <span class="del-entry-tags">
                      <Show when={e.kind === "repo"} fallback={<span class="del-tag muted">{e.kind}</span>}>
                        <Show when={props.loading}>
                          <span class="del-tag muted">checking…</span>
                        </Show>
                        <Show when={!props.loading && e.dirty}>
                          <span class="del-tag warn">uncommitted</span>
                        </Show>
                        <Show when={!props.loading && e.unpushed}>
                          <span class="del-tag warn">unpushed</span>
                        </Show>
                      </Show>
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="modal-label">
            Type <strong>{props.groupName}</strong> to confirm
          </div>
          <input
            ref={input}
            class="modal-input"
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <div class="modal-actions">
            <button class="modal-btn" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button class="modal-btn danger" disabled={!matches()} onClick={() => props.onConfirm()}>
              Delete group
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
