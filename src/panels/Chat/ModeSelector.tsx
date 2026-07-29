import { For, Show } from "solid-js";
import { SlidersHorizontal } from "lucide-solid";
import Picker, { PickerOption } from "./Picker";
import type { PermissionMode } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/**
 * The `--permission-mode` control.
 *
 * **The only one in the app.** The model and effort pickers sit beside it in
 * the composer bar and consume this rather than growing a second mode control:
 * two controls writing one piece of session state is how they end up
 * disagreeing about which mode the session is in.
 *
 * A pill in the composer, because the mode is changed occasionally mid
 * conversation rather than studied before starting one. Each mode's hint rides
 * its own row now instead of a tooltip on a native `<option>`, which nothing
 * ever showed.
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
  const title = () =>
    [current()?.hint, props.mode === "bypassPermissions" ? BYPASS_STILL_APPROVED : null].filter(Boolean).join(" ");

  return (
    <>
      <Picker
        icon={SlidersHorizontal}
        value={current()?.label ?? "Default"}
        ariaLabel="Permission mode"
        title={title()}
        disabled={props.disabled}
        pending={props.pending}
        attention={props.mode === "bypassPermissions"}
      >
        <For each={MODES}>
          {(m) => (
            <PickerOption
              label={m.label}
              description={m.hint}
              selected={m.value === props.mode}
              onSelect={() => props.onSelect(m.value)}
            />
          )}
        </For>
      </Picker>
      {/* Never "switched to X": the CLI applies a mode at a turn boundary, and
          a control that claimed otherwise would be wrong for the rest of the
          running turn - which is exactly the turn the user is worried about. */}
      <Show when={props.pending}>
        <span class={`${styles.barNote} ${styles.barNotePending}`}>Applies from the next turn.</span>
      </Show>
    </>
  );
}
