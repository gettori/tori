import { createSignal, Show } from "solid-js";
import { Lock } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import SpaceAppearance, { randomAppearance, type Appearance } from "./SpaceAppearance";
import { badName } from "../../utils/names";

export type SpaceDialogMode = "new" | "edit";

// The visible "Name" line is the field's accessible name, rather than an
// `aria-label` repeating it (the convention `NewProjectDialog` set in #99), so
// the two cannot drift apart. The help line under it is the field's
// description, so the collision message is announced with the field rather than
// only painted beside it. "new" only: edit mode has no control to name, its
// name being static text. Static ids: only one space dialog can be open at a
// time.
const NAME_LABEL = "space-name-label";
const NAME_HELP = "space-name-help";

/** Whether `name` collides with one of `taken`, on the same terms the base
 *  folder does: trimmed, and case-insensitive because two folders differing
 *  only in case is a distinction the user did not intend to draw and one macOS
 *  will not keep anyway. */
function collides(name: string, taken: string[]): boolean {
  const t = name.trim().toLowerCase();
  return !!t && taken.some((n) => n.trim().toLowerCase() === t);
}

/**
 * Create or edit a space: a name, and how it looks.
 *
 * **The appearance arrives already chosen.** A new space opens on a random
 * swatch and a random icon, so the dialog is valid the moment a name is typed
 * and neither picker ever blocks a submit. The row below the name previews that
 * choice and hands it to two popovers and a die; see `SpaceAppearance`.
 *
 * **The help line is one line, replaced rather than stacked.** The default copy
 * and the collision error occupy the same row, so the group never grows by a
 * line mid-keystroke and the fields below it never move.
 *
 * In "edit" mode the name is a locked row: no folder is created, and the folder
 * on disk carries the name, so colour and icon are the whole of what changes.
 *
 * The shell is `Dialog`. Enter stays here, through its `onKeyDown`, because the
 * confirm button is `disabled` while the name is invalid and a disabled button
 * is never clicked. Escape does not: Kobalte reports it as `onClose`.
 */
export default function SpaceDialog(props: {
  mode: SpaceDialogMode;
  // "edit": the space's immutable name. "new": the initial value (usually "").
  name: string;
  // Preselected icon name (a PICKER_ICONS key), or null for "no icon".
  icon: string | null;
  // Preselected swatch name (a SPACE_COLORS key), or null for "derive from the
  // name", which is what an untouched space uses.
  color: string | null;
  /** Every space already in the base folder, for the collision check. The
   *  space's own name is harmless in here: "edit" never validates. */
  spaces: string[];
  busy: boolean;
  onConfirm: (opts: { name: string; icon: string | null; color: string | null }) => void;
  onCancel: () => void;
}) {
  const isNew = () => props.mode === "new";

  const [name, setName] = createSignal(props.name);
  const [look, setLook] = createSignal<Appearance>(
    isNew() ? randomAppearance() : { color: props.color, icon: props.icon },
  );
  let first: HTMLInputElement | undefined;

  // Only "new" validates: "edit" creates no folder, so there is nothing a name
  // could be wrong for. An empty name is not an error state - it is where the
  // dialog starts - so it disables the button and leaves the default help up.
  const nameError = () => {
    if (!isNew()) return null;
    const typed = name().trim();
    if (!typed) return null;
    if (collides(typed, props.spaces)) return `A space named ${typed} already exists in this base folder.`;
    return badName(typed);
  };
  const canConfirm = () => !isNew() || (!!name().trim() && !nameError());

  const confirm = () => {
    if (props.busy || !canConfirm()) return;
    const look_ = look();
    props.onConfirm({
      name: isNew() ? name().trim() : props.name,
      icon: look_.icon,
      color: look_.color,
    });
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
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
            {props.busy ? "Working…" : isNew() ? "Create space" : "Save"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.spaceField}>
          {/* The id sits on the word, not on the row: the row also holds the
              Required pill, and an accessible name is computed from the text of
              whatever the id names. "Name Required" is not what this field is
              called, and `aria-required` on it already says the rest. */}
          <div class={styles.spaceLabel}>
            <span id={NAME_LABEL}>Name</span>
            {/* Only where it can still be set: in "edit" the name is already
                on disk, so nothing about it is outstanding. */}
            <Show when={isNew()}>
              <span class={styles.spaceRequired} aria-hidden="true">Required</span>
            </Show>
          </div>
          <Show
            when={isNew()}
            fallback={
              // Static text, not a named control: there is nothing here to
              // operate, so the "Name" line above is read in order rather than
              // through an `aria-labelledby` - which on a role-less element is
              // prohibited anyway, and which axe reports as such.
              <div class={styles.lockedName}>
                <span>{props.name}</span>
                <Icon icon={Lock} class={styles.lockedGlyph} aria-hidden="true" />
              </div>
            }
          >
            <input
              ref={first}
              class={styles.spaceInput}
              classList={{ [styles.invalid]: !!nameError() }}
              aria-labelledby={NAME_LABEL}
              aria-describedby={NAME_HELP}
              aria-required={true}
              aria-invalid={!!nameError()}
              value={name()}
              placeholder="space name"
              onInput={(e) => setName(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
          </Show>
          <div
            id={NAME_HELP}
            class={styles.spaceHelp}
            classList={{ [styles.helpError]: !!nameError() }}
          >
            <Show
              when={isNew()}
              fallback="The folder on disk carries this name, so it can’t change here. Colour and icon can."
            >
              {nameError() ?? "Becomes a folder in your base folder. Pick something short."}
            </Show>
          </div>
        </div>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>Appearance</div>
          <SpaceAppearance
            name={isNew() ? name() : props.name}
            value={look()}
            onChange={setLook}
          />
          {/* Only in "new": the locked-name help above already established that
              this is where the help for a group sits, and saying it twice in a
              dialog this short reads as a warning rather than a caption. */}
          <Show when={isNew()}>
            <div class={styles.spaceHelp}>
              Picked for you. Click a chip to choose your own, or reroll both.
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
