import { For } from "solid-js";
import { bindingsByGroup, GROUP_LABELS } from "../../utils/hotkeys";
import Dialog from "../Dialog/Dialog";
import styles from "./ShortcutSheet.module.css";

/**
 * The Cmd+/ shortcut sheet. Renders straight from the canonical BINDINGS
 * table in utils/hotkeys.ts - the same table the dispatcher matches against -
 * so the sheet cannot drift from what the keys actually do.
 *
 * Read-only: it lists bindings, it does not rebind them. Remapping lives in
 * Settings.
 *
 * Everything modal about it is `Dialog`'s. Two hand-built pieces went with the
 * migration and are worth naming, because both looked load-bearing:
 *
 *   * **The capture-phase `window` keydown.** It existed because a focused xterm
 *     swallows keydown before it reaches window, so Escape had to be caught on
 *     the way down. A real focus trap makes the question moot: the sheet takes
 *     focus when it opens, so the keystroke starts inside it.
 *   * **The manual focus save and restore.** `Dialog` captures the element that
 *     had focus at open time and puts it back on close, which is the same
 *     contract this used to implement for itself.
 *
 * `wide` is the panel behavior this wants; the width is still its own, see
 * `.sheetWidth` in the stylesheet.
 */
export default function ShortcutSheet(props: { onClose: () => void }) {
  return (
    <Dialog
      open
      size="wide"
      class={styles.sheetWidth}
      title="Keyboard shortcuts"
      description="Esc to close"
      onClose={props.onClose}
    >
      <div class={styles.groups}>
        <For each={bindingsByGroup()}>
          {(group) => (
            <section class={styles.group}>
              <h3 class={styles.groupTitle}>{GROUP_LABELS[group.group]}</h3>
              <For each={group.bindings}>
                {(binding) => (
                  <div class={styles.row}>
                    <span class={styles.label}>{binding.label}</span>
                    <span class={styles.keys}>
                      <For each={binding.keys}>{(key) => <kbd class={styles.key}>{key}</kbd>}</For>
                    </span>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}
