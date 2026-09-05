import { For, Show } from "solid-js";
import Popover from "../Popover/Popover";
import Switch from "../Switch/Switch";
import { findAdapter } from "../../utils/agents";
import { agentHealthFor, asProfileId, asTabProfile, namedProfiles, profileLabel } from "../../utils/agentHealth";
import { limitTypeLabel, paceOutAt, quotaState, resetsAtMs } from "../../utils/chatRateLimit";
import { settings } from "../../panels/Settings/settingsStore";
import { setUsage, usageNotify, usageSource } from "../../utils/usageSettings";
import { temporalOf, windowsFor, type WindowReading } from "../../utils/usageStore";
import styles from "./UsageCard.module.css";

// What the strip is short for.
//
// **Read-only on hover, interactive on pinned.** A card that arrives under the
// pointer with live controls on it is a card you change by accident on the way
// to somewhere else, so hovering explains and clicking commits. The two states
// share one surface rather than being two components: what the reader is looking
// at does not change, only whether they can act on it.
//
// Reuses `Popover` rather than adding a HoverCard door to the primitives. The
// hover timing belongs to the strip (it is the thing the pointer is on and off);
// what a popover owns is dismissal, focus and portalling, which is the same here
// as it is for the history dropdown.

/** How long the card is, per row, from a source's own reading. */
function windowLine(w: WindowReading, warnAt: number, now: number) {
  const state = quotaState(w, warnAt, now);
  const at = resetsAtMs(w.resetsAt);
  const kind = limitTypeLabel(w.kind) ?? w.kind;
  const pct = w.utilization === null ? null : Math.round(w.utilization * 100);
  return {
    kind,
    state,
    temporal: temporalOf(w, now),
    // No percentage past the reset: the level belongs to a window that has
    // since emptied, and printing it beside the word "reset" is the one
    // contradiction this card must not put on screen.
    level: state === "expired" || pct === null ? null : `${pct}%`,
    resets:
      state === "expired"
        ? "reset"
        : at === null
          ? null
          : `resets ${new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
    source: w.source,
    sampled: new Date(w.sampledAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    pace: paceOutAt(w, now),
  };
}

export default function UsageCard(props: {
  agentId: string;
  /** The backend's spelling, so `"default"` rather than null. */
  profile: string;
  anchorEl: HTMLElement;
  /** Pinned by a click: leaving no longer closes it, and the controls work. */
  pinned: boolean;
  now: number;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const tab = () => asTabProfile(props.profile);
  const adapter = () => findAdapter(props.agentId);
  const label = () => profileLabel(props.agentId, tab()) ?? adapter().label;

  /**
   * The email the agent's own `whoami` named, when it names one. Claude is the
   * only bundled agent that does.
   *
   * Two places to look, because `namedProfiles` is empty on a one-account
   * install by design ("Default" is a word for the only thing there is). That
   * install is the common case, so reading only the per-account list would leave
   * the card with no identity line at all for most users; the sweep's top-level
   * answer is the same probe, for the default account.
   */
  const account = () => {
    const named = namedProfiles(props.agentId).find((p) => p.id === props.profile)?.account;
    if (named) return named;
    return props.profile === asProfileId(null) ? (agentHealthFor(props.agentId)?.account ?? null) : null;
  };

  const warnAt = () => settings.budgets?.warnAtFraction ?? 1;
  const lines = () => windowsFor(props.agentId, tab()).map((w) => windowLine(w, warnAt(), props.now));

  return (
    <Popover
      anchorEl={props.anchorEl}
      onClose={props.onClose}
      placement="bottom-end"
      class={styles.card}
      aria-label={`${label()} usage detail`}
    >
      <div onMouseEnter={() => props.onPointerEnter?.()} onMouseLeave={() => props.onPointerLeave?.()}>
        <header class={styles.head}>
          <span class={styles.who}>{label()}</span>
          <Show when={account()}>{(email) => <span class={styles.email}>{email()}</span>}</Show>
        </header>

        <ul class={styles.windows}>
          <For each={lines()}>
            {(line) => (
              <li class={styles.window} data-state={line.state} data-temporal={line.temporal}>
                <span class={styles.kind}>{line.kind}</span>
                <span class={styles.level}>{line.level ?? "-"}</span>
                <Show when={line.resets}>{(r) => <span class={styles.resets}>{r()}</span>}</Show>
                <span class={styles.provenance}>
                  {line.source}, read {line.sampled}
                </span>
                {/* Only when carrying on as you are runs out first. A projection
                    landing past the reset says nothing the bar has not. */}
                <Show when={line.pace}>
                  {(out) => (
                    <span class={styles.pace}>
                      on pace to run out {new Date(out()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>

        <footer class={styles.foot}>
          <Switch
            checked={usageNotify(props.agentId)}
            // Read-only until pinned, and `aria-disabled` rather than `disabled`
            // so the reason stays reachable: a hovering reader can still see what
            // the control says, they just cannot move it by passing over it.
            aria-disabled={!props.pinned}
            onChange={(on) => {
              if (props.pinned) void setUsage(props.agentId, { notify: on });
            }}
            label="Notify"
            aria-label={`Notify about ${label()} quota`}
          />
          <button
            type="button"
            class={styles.breakdown}
            // The 7-day view is Phase 5's. Present and refusing rather than
            // absent, so the card's shape does not change when it arrives. The
            // refusal is in the name, not a native tooltip: a disabled control
            // never fires one, so it would say nothing to anybody.
            disabled
            aria-label="Breakdown, not built yet"
          >
            Breakdown
          </button>
          <span class={styles.source}>source: {usageSource(props.agentId)}</span>
        </footer>
      </div>
    </Popover>
  );
}
