import { createSignal, For, Show, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { SPACE_ICONS } from "../Icon/iconRegistry";

export type SpaceDialogMode = "new" | "edit";

// Create or edit a space, centred on an icon picker (a "None" tile + the 40
// fixed SPACE_ICONS). In "new" mode the Name field is editable with inline
// validation (UX only; the server's `valid_name` is the real guard) and the
// name is permanent once created. In "edit" mode the name is read-only (no
// folder is created), so the icon is the only editable field. Enter confirms,
// Escape or a backdrop click cancels.
export default function SpaceDialog(props: {
  mode: SpaceDialogMode;
  // "edit": the space's immutable name. "new": the initial value (usually "").
  name: string;
  // Preselected icon name (a SPACE_ICONS key), or null for "None".
  icon: string | null;
  busy: boolean;
  onConfirm: (opts: { name: string; icon: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal(props.name);
  const [icon, setIcon] = createSignal<string | null>(props.icon);
  let first: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => first?.focus()));

  const isNew = () => props.mode === "new";

  // Inline mirror of the server's `valid_name`, for immediate UX feedback only.
  function badName(n: string): string | null {
    const t = n.trim();
    if (!t) return "Name is empty";
    if (t.includes("/") || t.includes("\\")) return "Name cannot contain a slash";
    if (t.startsWith(".")) return "Name cannot start with a dot";
    return null;
  }

  // Only "new" validates the name (it creates a folder); "edit" never does.
  const nameError = () => (isNew() ? badName(name()) : null);
  const canConfirm = () => !isNew() || !nameError();

  const confirm = () => {
    if (props.busy || !canConfirm()) return;
    props.onConfirm({ name: isNew() ? name().trim() : props.name, icon: icon() });
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>{isNew() ? "New space" : `Edit “${props.name}”`}</div>

          <div class={styles.modalLabel}>Name</div>
          <Show
            when={isNew()}
            fallback={<input class={styles.modalInput} value={props.name} disabled readonly />}
          >
            <input
              ref={first}
              class={styles.modalInput}
              value={name()}
              placeholder="space name"
              onInput={(e) => setName(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
            <Show when={nameError()}>{(err) => <div class={styles.modalHint}>{err()}</div>}</Show>
            <div class={styles.modalNote}>
              The name can’t be changed later, but you can always change the icon.
            </div>
          </Show>

          <div class={styles.modalLabel}>Icon</div>
          <div class={styles.iconGrid} role="group" aria-label="Space icon">
            <button
              type="button"
              class={styles.iconTile}
              classList={{ [styles.iconSelected]: icon() === null }}
              aria-pressed={icon() === null}
              title="No icon"
              onClick={() => setIcon(null)}
            >
              <span class={styles.iconNone}>None</span>
            </button>
            <For each={SPACE_ICONS}>
              {(entry) => (
                <button
                  type="button"
                  class={styles.iconTile}
                  classList={{ [styles.iconSelected]: icon() === entry.name }}
                  aria-pressed={icon() === entry.name}
                  title={entry.name}
                  onClick={() => setIcon(entry.name)}
                >
                  <Icon icon={entry.icon} size={18} />
                </button>
              )}
            </For>
          </div>

          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>Cancel</Button>
            <Button
              variant="primary"
              disabled={props.busy || !canConfirm()}
              onClick={() => confirm()}
            >
              {props.busy ? "Working…" : isNew() ? "Create" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
