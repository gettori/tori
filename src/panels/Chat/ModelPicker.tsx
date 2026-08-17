import { For, Show, createMemo, createSignal } from "solid-js";
import { ChartNoAxesColumn } from "lucide-solid";
import { providerIcon } from "../../components/Icon/ProviderIcon";
import Picker, { PickerMore, PickerOption } from "./Picker";
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

/** How many models the menu shows before the rest move to a second page. Set
 *  above the size of a real catalogue (this machine's Claude offers five) so the
 *  common case is one flat list: a "More models" row hiding a single entry is
 *  a fold that costs a click and saves nothing. */
const FLAT_LIMIT = 7;

export default function ModelPicker(props: {
  models: readonly PickableModel[];
  /** The `--model` value shown as selected, or null when nothing is known. The
   *  caller resolves this: `ChatView` is where the pick, the id `system/init`
   *  reported, and the transcript's own model all meet. */
  value: string | null;
  /** The adapter driving this session, so the pill can still show a provider
   *  mark before any model id has been reported. Optional: a caller that does
   *  not name one gets the generic glyph rather than a guessed vendor. */
  agentId?: string;
  effort: string | null;
  modelPending: boolean;
  effortPending: boolean;
  disabled: boolean;
  onSelectModel: (model: PickableModel) => void;
  onSelectEffort: (effort: string) => void;
}) {
  const [showAll, setShowAll] = createSignal(false);
  const current = () => props.models.find((m) => m.value === props.value) ?? null;
  const levels = () => current()?.effortLevels ?? [];
  // A cached list is the agent's own answer from the last time anything asked,
  // which is a different claim from what this session reports right now. Worth
  // saying so rather than presenting a remembered answer as a current one.
  const stale = () => props.models.length > 0 && !props.models[0].live;

  // The selected model is always on the first page even when it sorts past the
  // limit: a menu whose checkmark is on a page you have to go looking for reads
  // as though nothing is selected.
  const firstPage = createMemo(() => {
    if (props.models.length <= FLAT_LIMIT) return props.models;
    const head = props.models.slice(0, FLAT_LIMIT);
    const sel = current();
    return sel && !head.includes(sel) ? [...head.slice(0, FLAT_LIMIT - 1), sel] : head;
  });
  const hasMore = () => props.models.length > firstPage().length;

  return (
    <>
      <Picker
        icon={providerIcon(current()?.resolvedModel || props.value, props.agentId)}
        value={current()?.label ?? (props.models.length === 0 ? "No models" : "Default")}
        ariaLabel="Model"
        tooltip={current()?.description || "Model"}
        disabled={props.disabled || props.models.length === 0}
        pending={props.modelPending}
        onClose={() => setShowAll(false)}
      >
        <For each={showAll() ? props.models : firstPage()}>
          {(m) => (
            <PickerOption
              label={m.label}
              description={m.description}
              selected={m.value === props.value}
              onSelect={() => props.onSelectModel(m)}
            />
          )}
        </For>
        <Show when={hasMore() && !showAll()}>
          <div class={styles.pickSep} />
          <PickerMore label="More models" onOpen={() => setShowAll(true)} />
        </Show>
      </Picker>

      {/* Hidden, not disabled: a model with no effort levels has no control to
          offer, and an inert one reads as a broken control. */}
      <Show when={levels().length > 0}>
        <Picker
          icon={ChartNoAxesColumn}
          prefix="Thinking:"
          /* Nothing on the wire reports effort back, so before a pick the level
             in force is the CLI's own default and Sway does not know which it
             is. Saying "Default" is honest; naming a level would not be. */
          value={props.effort ?? "Default"}
          ariaLabel="Thinking effort"
          tooltip="Thinking effort"
          disabled={props.disabled}
          pending={props.effortPending}
        >
          <For each={levels()}>
            {(level) => (
              <PickerOption
                label={level}
                selected={level === props.effort}
                onSelect={() => props.onSelectEffort(level)}
              />
            )}
          </For>
        </Picker>
      </Show>

      <Show when={props.modelPending || props.effortPending}>
        <span class={`${styles.barNote} ${styles.barNotePending}`}>Applies from the next turn.</span>
      </Show>

      <Show when={stale()}>
        <span class={styles.barNote} title="This session did not report its own model list.">
          Last known list: this session has not reported its own yet.
        </span>
      </Show>
    </>
  );
}
