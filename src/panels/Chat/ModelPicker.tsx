import { For, Show, createSignal } from "solid-js";
import { ChartNoAxesColumn } from "lucide-solid";
import { providerIcon } from "../../components/Icon/ProviderIcon";
import AgentPalette from "./AgentPalette";
import Picker, { PickerButton, PickerOption } from "./Picker";
import type { PaletteProvider } from "./agentPaletteData";
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
 *
 * The model pill opens `AgentPalette` rather than a menu of its own. Same
 * surface for a draft and for a live session: what changes is how many agents
 * it is handed.
 */

export default function ModelPicker(props: {
  /** The selected model's own row lives here: the pill's label, and the effort
   *  levels it offers. Separate from `providers`, which is what the palette
   *  lists, because a draft's pill names a model no session has confirmed. */
  models: readonly PickableModel[];
  /** What the palette shows. One entry is a locked session; every chat-capable
   *  agent is a draft. */
  providers: readonly PaletteProvider[];
  /** The `--model` value shown as selected, or null when nothing is known. The
   *  caller resolves this: `ChatView` is where the pick, the id `system/init`
   *  reported, and the transcript's own model all meet. */
  value: string | null;
  /** The adapter driving this session, so the pill can still show a provider
   *  mark before any model id has been reported. */
  agentId: string;
  effort: string | null;
  modelPending: boolean;
  effortPending: boolean;
  disabled: boolean;
  onSelectModel: (agentId: string, model: PickableModel) => void;
  onSelectEffort: (effort: string) => void;
  /** An agent row moved under the cursor, for a caller that probes on highlight. */
  onHighlightAgent?: (agentId: string) => void;
  /** A "Fix" row was activated. */
  onFixAgent?: (agentId: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const current = () => props.models.find((m) => m.value === props.value) ?? null;
  const levels = () => current()?.effortLevels ?? [];
  // A cached list is the agent's own answer from the last time anything asked,
  // which is a different claim from what this session reports right now. Worth
  // saying so rather than presenting a remembered answer as a current one.
  const stale = () => props.models.length > 0 && !props.models[0].live;

  return (
    <>
      <PickerButton
        icon={providerIcon(current()?.resolvedModel || props.value, props.agentId)}
        value={current()?.label ?? (props.models.length === 0 ? "No models" : "Default")}
        ariaLabel="Model"
        tooltip={current()?.description || "Model"}
        disabled={props.disabled}
        pending={props.modelPending}
        onOpen={() => setOpen(true)}
      />

      <Show when={open()}>
        <AgentPalette
          providers={props.providers}
          agentId={props.agentId}
          value={props.value}
          onSelect={(agentId, model) => {
            setOpen(false);
            props.onSelectModel(agentId, model);
          }}
          onHighlight={props.onHighlightAgent}
          onFix={(agentId) => {
            setOpen(false);
            props.onFixAgent?.(agentId);
          }}
          onClose={() => setOpen(false)}
        />
      </Show>

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
