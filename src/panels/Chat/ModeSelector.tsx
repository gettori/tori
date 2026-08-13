import { For, Show } from "solid-js";
import { SlidersHorizontal } from "lucide-solid";
import Picker, { PickerOption } from "./Picker";
import type { ChatConfig, ChatMode } from "../../utils/agents";
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
 * conversation rather than studied before starting one.
 *
 * **The rows come from the adapter**, not from a list in this file. There used
 * to be one here, and it had already drifted from the TOML it was supposed to
 * mirror: the same mode was labelled "Default" here and "Ask" there. A second
 * list cannot be kept in step with the first, only checked against it, and
 * nothing was checking.
 */

/** Said wherever a mode declaring `permissive_caveat` is reachable, because
 *  such a mode's name is a promise Sway deliberately does not keep. Sway's
 *  `PreToolUse` hook runs *first* in the permission chain, ahead of deny rules,
 *  ask rules and the mode itself, so a call matching no allow rule still stops
 *  here. Which mode carries it is the adapter's to say: the caveat is a fact
 *  about Sway's gate, and it holds whatever a harness calls its permissive mode. */
export const BYPASS_STILL_APPROVED = "Sway still asks: its approval hook runs ahead of Claude's permission modes.";

/** Whether the mode in force is one the adapter flagged as needing the caveat. */
export function needsPermissiveCaveat(chat: ChatConfig | null, mode: PermissionMode | null): boolean {
  return !!chat?.modes.some((m) => m.id === mode && m.permissive_caveat);
}

export default function ModeSelector(props: {
  /** Null before the session has reported one and with no adapter default to
   *  stand in, which shows as "Mode" rather than as a mode it is not in. */
  mode: PermissionMode | null;
  /** The modes actually on offer: the adapter's declaration already narrowed to
   *  what the selected model supports, so a mode the CLI would silently ignore
   *  never reaches the menu. */
  modes: readonly ChatMode[];
  /** True while the shown mode is a pick that has not taken effect yet. */
  pending: boolean;
  disabled: boolean;
  onSelect: (mode: PermissionMode) => void;
}) {
  const current = () => props.modes.find((m) => m.id === props.mode) ?? null;
  // The id itself when the session reports a mode this adapter does not declare
  // - a stale pick, or a mode gated away by the current model. Showing the raw
  // id is worse than a label and better than a lie about which mode is running.
  const label = () => current()?.label ?? props.mode ?? "Mode";
  const needsCaveat = () => !!current()?.permissive_caveat;
  const title = () =>
    [current()?.hint, props.mode !== null && needsCaveat() ? BYPASS_STILL_APPROVED : null].filter(Boolean).join(" ");

  return (
    <>
      <Picker
        icon={SlidersHorizontal}
        value={label()}
        ariaLabel="Permission mode"
        tooltip={title()}
        disabled={props.disabled || props.modes.length === 0}
        pending={props.pending}
        attention={needsCaveat()}
      >
        <For each={props.modes}>
          {(m) => (
            <PickerOption
              label={m.label}
              description={m.hint}
              selected={m.id === props.mode}
              onSelect={() => props.onSelect(m.id)}
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
