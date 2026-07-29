import { Show } from "solid-js";
import styles from "./Chat.module.css";

/**
 * Fast mode, as a **status rather than a toggle**.
 *
 * Probed live against claude 2.1.220 over this exact transport, by both routes
 * a toggle could take:
 *
 *   * **The control request.** `set_fast_mode` comes back
 *     `error: "Unsupported control request subtype: set_fast_mode"`.
 *   * **The slash command.** `/fast` *is* in the session's command catalogue,
 *     describing itself as "Toggle fast mode (Opus 5)", so the first
 *     measurement's conclusion was right for the wrong reason: it tested only
 *     the control request, and a capability missing from the request API can
 *     still be present in the catalogue. Sending `/fast on` on Opus 5 - the
 *     model it names - answers "Fast mode is not available in the Agent SDK",
 *     and `fast_mode_state` stays `"off"` on the sending turn's `system/init`
 *     and on the next turn's, which is where a late change would have shown.
 *     Identical on `sonnet`, so the refusal is the transport's, not the
 *     model's. Captured as `dev/fixtures/claude/fast-mode.jsonl`, whose
 *     scenario asserts the refusal and fails loudly if a later CLI opts in.
 *
 * Neither route moves it, so a toggle would be a control that cannot move -
 * which reads as broken rather than as unavailable. The reason is the honest
 * thing to ship, and it is the harness's own words.
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
