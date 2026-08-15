import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import IconGrid from "../IconGrid/IconGrid";
import { searchIcons } from "../Icon/iconRegistry";
import { SPACE_COLORS, spaceHueRgb, rgbTriple } from "../../utils/spaceTint";

export type SpaceDialogMode = "new" | "edit";

// The visible "Name" line is also the field's accessible name in both modes,
// rather than an `aria-label` repeating it (the convention `NewProjectDialog`
// set in #99). Edit mode is why this matters: its field is disabled with no
// placeholder, so before this it had no accessible name at all. Static id: only
// one space dialog can be open at a time.
const NAME_LABEL = "space-name-label";

// Create or edit a space, centred on an icon picker (a "None" tile + the fixed
// PICKER_ICONS set, filtered by a search field since the set outgrew one
// screenful). In "new" mode the Name field is editable with inline validation
// (UX only; the server's `valid_name` is the real guard) and the name is
// permanent once created. In "edit" mode the name is read-only (no folder is
// created), so the icon is the only editable field.
//
// The shell is `Dialog`. Enter stays here, through its `onKeyDown`, because the
// confirm button is `disabled` while the name is invalid and a disabled button
// is never clicked. Escape does not: Kobalte reports it as `onClose`.
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
  let first: HTMLInputElement | undefined;

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
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  return (
    <Dialog
      open
      title={isNew() ? "New space" : `Edit “${props.name}”`}
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || !canConfirm()}
            onClick={() => confirm()}
          >
            {props.busy ? "Working…" : isNew() ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <div id={NAME_LABEL} class={styles.label}>Name</div>
      <Show
        when={isNew()}
        fallback={
          <input
            class={styles.input}
            aria-labelledby={NAME_LABEL}
            value={props.name}
            disabled
            readonly
          />
        }
      >
        <input
          ref={first}
          class={styles.input}
          aria-labelledby={NAME_LABEL}
          value={name()}
          placeholder="space name"
          onInput={(e) => setName(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <Show when={nameError()}>{(err) => <div class={styles.hint}>{err()}</div>}</Show>
        <div class={styles.note}>
          The name can’t be changed later, but you can always change the icon.
        </div>
      </Show>

      <div class={styles.label}>Colour</div>
      {/* "Auto" is a state, not a swatch: it hands the hue back to the name,
          which is what an untouched space already uses. Its own preview shows
          what that derives to, so the choice is visible rather than a leap. */}
      <IconGrid
        variant="swatch"
        aria-label="Space colour"
        value={color()}
        onChange={setColor}
        leading={{
          label: "Automatic (from the name)",
          tint: spaceHueRgb(isNew() ? name() : props.name, null),
          content: <span class={styles.swatchAuto}>A</span>,
        }}
        tiles={() =>
          SPACE_COLORS.map((entry) => ({
            value: entry.name,
            label: entry.name,
            tint: rgbTriple(entry.hex),
          }))
        }
      />
      <div class={styles.note}>Tints the window behind this space.</div>

      <div class={styles.label}>Icon</div>
      {/* "None" is a state, not a search result, so it stays put while the grid
          filters - otherwise clearing an icon would need the query cleared
          first. */}
      <IconGrid
        aria-label="Space icon"
        value={icon()}
        onChange={setIcon}
        leading={{ label: "No icon", content: <span class={styles.iconNone}>None</span> }}
        tiles={(query) =>
          searchIcons(query).map((entry) => ({
            value: entry.name,
            label: entry.name,
            content: <Icon icon={entry.icon} />,
          }))
        }
        search={{ label: "Search icons", placeholder: "Search icons" }}
      />
    </Dialog>
  );
}
