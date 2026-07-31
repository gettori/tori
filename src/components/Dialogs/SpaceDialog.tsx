import { createSignal, For, Show, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { searchIcons } from "../Icon/iconRegistry";
import { SPACE_COLORS, spaceHueRgb, rgbTriple } from "../../utils/spaceTint";

export type SpaceDialogMode = "new" | "edit";

// Create or edit a space, centred on an icon picker (a "None" tile + the fixed
// PICKER_ICONS set, filtered by a search field since the set outgrew one
// screenful). In "new" mode the Name field is editable with inline validation
// (UX only; the server's `valid_name` is the real guard) and the name is
// permanent once created. In "edit" mode the name is read-only (no folder is
// created), so the icon is the only editable field. Enter confirms, Escape or a
// backdrop click cancels.
export default function SpaceDialog(props: {
  mode: SpaceDialogMode;
  // "edit": the space's immutable name. "new": the initial value (usually "").
  name: string;
  // Preselected icon name (a PICKER_ICONS key), or null for "None".
  icon: string | null;
  // Preselected swatch name (a SPACE_COLORS key), or null for "derive from the
  // name", which is what an untouched space uses.
  color: string | null;
  busy: boolean;
  onConfirm: (opts: { name: string; icon: string | null; color: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal(props.name);
  const [icon, setIcon] = createSignal<string | null>(props.icon);
  const [color, setColor] = createSignal<string | null>(props.color);
  const [iconQuery, setIconQuery] = createSignal("");
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
    props.onConfirm({ name: isNew() ? name().trim() : props.name, icon: icon(), color: color() });
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

          <div class={styles.modalLabel}>Colour</div>
          <div class={styles.swatchRow} role="group" aria-label="Space colour">
            {/* "Auto" is a state, not a swatch: it hands the hue back to the
                name, which is what an untouched space already uses. Its own
                preview shows what that derives to, so the choice is visible
                rather than a leap. */}
            <button
              type="button"
              class={styles.swatch}
              classList={{ [styles.swatchSelected]: color() === null }}
              aria-pressed={color() === null}
              title="Automatic (from the name)"
              style={{ "--swatch-rgb": spaceHueRgb(isNew() ? name() : props.name, null) }}
              onClick={() => setColor(null)}
            >
              <span class={styles.swatchAuto}>A</span>
            </button>
            <For each={SPACE_COLORS}>
              {(entry) => (
                <button
                  type="button"
                  class={styles.swatch}
                  classList={{ [styles.swatchSelected]: color() === entry.name }}
                  aria-pressed={color() === entry.name}
                  title={entry.name}
                  style={{ "--swatch-rgb": rgbTriple(entry.hex) }}
                  onClick={() => setColor(entry.name)}
                />
              )}
            </For>
          </div>
          <div class={styles.modalNote}>Tints the window behind this space.</div>

          <div class={styles.modalLabel}>Icon</div>
          <input
            class={styles.modalInput}
            value={iconQuery()}
            placeholder="Search icons"
            aria-label="Search icons"
            onInput={(e) => setIconQuery(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <div class={styles.iconGrid} role="group" aria-label="Space icon">
            {/* "None" is a state, not a search result, so it stays put while the
                grid filters - otherwise clearing an icon would need the query
                cleared first. */}
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
            <For each={searchIcons(iconQuery())}>
              {(entry) => (
                <button
                  type="button"
                  class={styles.iconTile}
                  classList={{ [styles.iconSelected]: icon() === entry.name }}
                  aria-pressed={icon() === entry.name}
                  title={entry.name}
                  onClick={() => setIcon(entry.name)}
                >
                  <Icon icon={entry.icon} />
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
