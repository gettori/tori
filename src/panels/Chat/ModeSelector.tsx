import { For, Show } from "solid-js";
import { SlidersHorizontal } from "lucide-solid";
import Picker, { PickerOption } from "./Picker";
import type { ChatMode } from "../../utils/agents";
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

/*
 * There used to be a caveat here - `BYPASS_STILL_APPROVED`, rendered wherever a
 * mode declared `permissive_caveat` - saying that Sway asked anyway because its
 * `PreToolUse` hook ran ahead of the permission chain. Both the flag and the
 * sentence are gone: the hook no longer decides, so `bypassPermissions` bypasses
 * permissions and a mode's name is now the truth about what it does. A warning
 * that no longer describes anything is worse than no warning, because it trains
 * people to discount the ones that do.
 *
 * What survives is the *chip*, on `permissive`. The sentence was about Sway and
 * went stale with Sway's gate; the highlight is about the mode, which really
 * does run tools unasked - and does so with nothing behind it now, which is a
 * better reason to keep noticing it than the one it had before.
 */

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
  const title = () => current()?.hint ?? "";

  return (
    <>
      <Picker
        icon={SlidersHorizontal}
        value={label()}
        ariaLabel="Permission mode"
        tooltip={title()}
        disabled={props.disabled || props.modes.length === 0}
        pending={props.pending}
        // Not the retired caveat under another name: that said Sway asked
        // anyway, and stopped being true. This marks a mode that runs tools
        // unasked, which is what the mode does and now what actually happens.
        attention={!!current()?.permissive}
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
