import { Show } from "solid-js";
import styles from "./Chat.module.css";

/**
 * Fast mode, as a **status rather than a toggle**.
 *
 * Probed live against claude 2.1.220 over this exact transport, twice: every
 * `system/init` reports `fast_mode_state: "off"` with
 * `fast_mode_disabled_reason: "sdk_opt_in_required"`, and the obvious control
 * request to change it comes back
 * `error: "Unsupported control request subtype: set_fast_mode"`. There is no
 * request that turns it on here, so a toggle would be a control that cannot
 * move - which reads as broken rather than as unavailable. The reason is the
 * honest thing to ship, and it is the harness's own words.
 *
 * Written to render a state it has never been able to observe (`on`) rather
 * than hardcoding the measurement: if a later CLI opts the SDK in, this reports
 * it instead of continuing to insist fast mode is off.
 *
 * Plan mode is deliberately absent. It is a permission mode and `ModeSelector`
 * already owns it; a second control writing the same session state is exactly
 * what that component's own note warns against.
 */
export default function FastModeStatus(props: { state: string | null; reason: string | null }) {
  // Wire values are snake_case identifiers meant for a machine. The known one is
  // spelled out; anything new falls through as-is rather than being hidden,
  // since an unreadable reason still beats a silent one.
  const reason = () => {
    if (props.reason === "sdk_opt_in_required") return "not available to this kind of session";
    return props.reason;
  };

  return (
    <Show when={props.state !== null}>
      <span class={styles.menuNote}>
        <Show when={props.state === "on"} fallback={<>Fast mode off{reason() ? `: ${reason()}` : ""}</>}>
          Fast mode on
        </Show>
      </span>
    </Show>
  );
}
