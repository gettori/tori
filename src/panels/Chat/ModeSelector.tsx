import { For, Show } from "solid-js";
import type { PermissionMode } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/**
 * The `--permission-mode` control.
 *
 * **The only one in the app.** Phase 9 adds model and effort pickers and
 * consumes this rather than growing a second mode control beside it: two
 * controls writing one piece of session state is how they end up disagreeing
 * about which mode the session is in.
 */
export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "Claude asks before acting outside its allowances." },
  { value: "acceptEdits", label: "Accept edits", hint: "File edits go through without Claude asking." },
  { value: "plan", label: "Plan", hint: "Claude plans and explains instead of editing." },
  {
    value: "bypassPermissions",
    label: "Bypass",
    hint: "Claude's own permission checks are skipped.",
  },
];

/** Said wherever bypass is reachable, because the mode's name is a promise Sway
 *  deliberately does not keep. Sway's `PreToolUse` hook runs *first* in the
 *  permission chain, ahead of deny rules, ask rules and the mode itself, so a
 *  call matching no allow rule still stops here. */
export const BYPASS_STILL_APPROVED = "Sway still asks: its approval hook runs ahead of Claude's permission modes.";

export default function ModeSelector(props: {
  mode: PermissionMode;
  /** True while the shown mode is a pick that has not taken effect yet. */
  pending: boolean;
  disabled: boolean;
  onSelect: (mode: PermissionMode) => void;
}) {
  const current = () => MODES.find((m) => m.value === props.mode);

  return (
    <div class={styles.modeGroup}>
      <div class={styles.modeButtons} role="group" aria-label="Permission mode">
        <For each={MODES}>
          {(m) => (
            <button
              type="button"
              class={`${styles.modeButton} ${props.mode === m.value ? styles.modeSelected : ""}`}
              title={m.value === "bypassPermissions" ? `${m.hint} ${BYPASS_STILL_APPROVED}` : m.hint}
              aria-pressed={props.mode === m.value}
              disabled={props.disabled}
              onClick={() => props.onSelect(m.value)}
            >
              {m.label}
            </button>
          )}
        </For>
      </div>
      {/* Never "switched to X": the CLI applies a mode at a turn boundary, and
          a control that claimed otherwise would be wrong for the rest of the
          running turn - which is exactly the turn the user is worried about. */}
      <span class={`${styles.modeNote} ${props.pending ? styles.modeNotePending : ""}`}>
        <Show when={props.pending} fallback={current()?.hint}>
          Applies from the next turn.
        </Show>
      </span>
      <Show when={props.mode === "bypassPermissions"}>
        <span class={styles.modeGuard}>{BYPASS_STILL_APPROVED}</span>
      </Show>
    </div>
  );
}
