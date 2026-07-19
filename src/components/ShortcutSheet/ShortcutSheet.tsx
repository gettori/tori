import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { bindingsByGroup, GROUP_LABELS } from "../../utils/hotkeys";
import styles from "./ShortcutSheet.module.css";

/**
 * The Cmd+/ shortcut sheet. Renders straight from the canonical BINDINGS
 * table in utils/hotkeys.ts - the same table the dispatcher matches against -
 * so the sheet cannot drift from what the keys actually do.
 *
 * Read-only: it lists bindings, it does not rebind them. Remapping lives in
 * Settings.
 */
export default function ShortcutSheet(props: { onClose: () => void }) {
  // Esc closes. Capture phase, because a focused xterm swallows keydown before
  // it bubbles to window - the same reason dispatchHotkey exists - and the
  // sheet must be dismissable no matter what had focus when it opened.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  }

  // Focus the sheet on open and restore focus on close. Without this the
  // aria-modal claim is a lie: focus would stay wherever it was (often a
  // terminal), so a screen reader never enters the dialog and the sheet is not
  // scrollable by keyboard.
  let sheetEl!: HTMLDivElement;
  let previouslyFocused: Element | null = null;

  onMount(() => {
    previouslyFocused = document.activeElement;
    sheetEl.focus();
    window.addEventListener("keydown", onKeyDown, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    (previouslyFocused as HTMLElement | null)?.focus?.();
  });

  return (
    <Portal>
      <div class={styles.backdrop} onClick={props.onClose}>
        <div
          ref={sheetEl}
          class={styles.sheet}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          tabindex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div class={styles.head}>
            <h2 class={styles.title}>Keyboard shortcuts</h2>
            <span class={styles.hint}>Esc to close</span>
          </div>
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
        </div>
      </div>
    </Portal>
  );
}
