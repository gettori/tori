import { For, Show } from "solid-js";
import { ChevronDown } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import type { PickableModel } from "../../utils/chatModels";
import styles from "./Chat.module.css";

/**
 * The `--model` and `--effort` controls, as pills in the composer bar.
 *
 * They live in one component because they are not independent: the levels on
 * offer are a property of the *selected* model, and a model that declares none
 * hides the control rather than rendering an inert one. Two components reading
 * one selection would each need the other's state to know what to show.
 *
 * Neither control claims an immediate effect. The CLI applies a switch at the
 * next turn boundary, so until one passes, the pick is a promise - the same
 * rule `ModeSelector` follows, and for the same measured reason.
 */
export default function ModelPicker(props: {
  models: readonly PickableModel[];
  /** The `--model` value shown as selected, or null before anything is known. */
  value: string | null;
  effort: string | null;
  /** Context the conversation currently occupies, or null before any turn has
   *  reported usage. Rendered only against a declared window. */
  contextTokens: number | null;
  modelPending: boolean;
  effortPending: boolean;
  disabled: boolean;
  onSelectModel: (model: PickableModel) => void;
  onSelectEffort: (effort: string) => void;
}) {
  // Before any pick, a session started without `--model` is running the
  // catalogue's own default entry by definition, so that entry is shown as
  // selected rather than a placeholder: "Starting..." on an idle chat read as
  // a control that never finished loading. A catalogue with no default entry
  // keeps the placeholder, because naming one would be a guess.
  const shownValue = () => props.value ?? props.models.find((m) => m.value === "default")?.value ?? null;
  const current = () => props.models.find((m) => m.value === shownValue()) ?? null;
  const levels = () => current()?.effortLevels ?? [];
  // The adapter table is a hand-maintained fallback, so a list drawn from it is
  // worth saying so about rather than presenting as this machine's truth.
  const stale = () => props.models.length > 0 && !props.models[0].live;

  return (
    <>
      <label class={styles.pill} classList={{ [styles.pillPending]: props.modelPending }} title="Model">
        <span class={styles.pillValue}>
          {current()?.label ?? (props.models.length === 0 ? "No models" : "Default")}
        </span>
        <span class={styles.pillCaret} aria-hidden="true">
          <Icon icon={ChevronDown} size={13} />
        </span>
        <select
          class={styles.pillSelect}
          aria-label="Model"
          disabled={props.disabled || props.models.length === 0}
          value={shownValue() ?? ""}
          onChange={(e) => {
            const picked = props.models.find((m) => m.value === e.currentTarget.value);
            if (picked) props.onSelectModel(picked);
          }}
        >
          {/* Only while nothing can be shown as selected: a placeholder that
              stayed selectable would be a pick that resolves to nothing. */}
          <Show when={shownValue() === null}>
            <option value="" disabled>
              {props.models.length === 0 ? "No models" : "Default"}
            </option>
          </Show>
          <For each={props.models}>
            {(m) => (
              <option value={m.value} title={m.description}>
                {m.label}
              </option>
            )}
          </For>
        </select>
      </label>

      {/* Hidden, not disabled: a model with no effort levels has no control to
          offer, and an inert one reads as a broken control. */}
      <Show when={levels().length > 0}>
        <label class={styles.pill} classList={{ [styles.pillPending]: props.effortPending }} title="Thinking effort">
          <span class={styles.pillPrefix}>Thinking:</span>
          <span class={styles.pillValue}>{props.effort ?? "Default"}</span>
          <span class={styles.pillCaret} aria-hidden="true">
            <Icon icon={ChevronDown} size={13} />
          </span>
          <select
            class={styles.pillSelect}
            aria-label="Thinking effort"
            disabled={props.disabled}
            value={props.effort ?? ""}
            onChange={(e) => props.onSelectEffort(e.currentTarget.value)}
          >
            {/* Nothing on the wire reports effort back, so before a pick the
                level in force is the CLI's own default and Sway does not know
                which it is. Saying "Default" is honest; naming a level would
                not be. */}
            <Show when={props.effort === null}>
              <option value="" disabled>
                Default
              </option>
            </Show>
            <For each={levels()}>{(level) => <option value={level}>{level}</option>}</For>
          </select>
        </label>
      </Show>

      {/* Only when a window is declared. Nothing declares one for every model,
          and a meter with an invented denominator is worse than no meter: it
          would read as a measurement. */}
      <Show when={current()?.contextWindow != null}>
        {(() => {
          const window = () => current()!.contextWindow!;
          const used = () => props.contextTokens;
          const pct = () => Math.min(100, Math.round(((used() ?? 0) / window()) * 100));
          return (
            <span
              class={styles.barNote}
              title={used() === null ? undefined : `${pct()}% of ${fmtTokens(window())} context used`}
            >
              <Show when={used() !== null} fallback={`${fmtTokens(window())} context`}>
                <span class={styles.contextMeter} aria-hidden="true">
                  <span class={styles.contextMeterFill} style={{ width: `${pct()}%` }} />
                </span>
                {fmtTokens(used()!)}/{fmtTokens(window())}
              </Show>
            </span>
          );
        })()}
      </Show>

      <Show when={props.modelPending || props.effortPending}>
        <span class={`${styles.barNote} ${styles.barNotePending}`}>Applies from the next turn.</span>
      </Show>

      <Show when={stale()}>
        <span class={styles.barNote} title="This session did not report its own model list.">
          From the adapter's list: this session did not report its own.
        </span>
      </Show>
    </>
  );
}

function fmtTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
