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
 * The model pill opens `AgentPalette` rather than a menu of its own, anchored to
 * the pill the same way those menus are. Same surface for a draft and for a live
 * session: what changes is how many agents it is handed.
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
  /** Ask an agent for its models again. Absent hides the control; see
   *  `AgentPalette`'s own `onRecheck`. */
  onRecheckAgent?: (agentId: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  // The pill the palette hangs off. A signal rather than a bare `let`, because
  // the panel mounts in the same update as the ref is read and a plain variable
  // would hand it `undefined` on that first render.
  const [pill, setPill] = createSignal<HTMLButtonElement>();
  const current = () => props.models.find((m) => m.value === props.value) ?? null;
  const levels = () => current()?.effortLevels ?? [];

  return (
    <>
      <PickerButton
        ref={setPill}
        icon={providerIcon(current()?.resolvedModel || props.value, props.agentId)}
        value={current()?.label ?? (props.models.length === 0 ? "No models" : "Default")}
        ariaLabel="Model"
        tooltip={current()?.description || "Model"}
        disabled={props.disabled}
        pending={props.modelPending}
        open={open()}
        onOpen={() => setOpen(!open())}
      />

      <Show when={open()}>
        <AgentPalette
          anchorEl={pill()}
          providers={props.providers}
          agentId={props.agentId}
          value={props.value}
          onSelect={(agentId, model) => {
            setOpen(false);
            props.onSelectModel(agentId, model);
          }}
          onHighlight={props.onHighlightAgent}
          onRecheck={props.onRecheckAgent}
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
          {/* Keyed by the level, not the row object: the catalogue is replaced
              wholesale whenever the agent answers, and keying on identity would
              rebuild the row the user is standing on. Same fix `ConfigMirror`
              took. */}
          <For each={levels().map((l) => l.level)}>
            {(level) => (
              <Show when={levels().find((l) => l.level === level)}>
                {(row) => (
                  <PickerOption
                    label={row().label || level}
                    selected={level === props.effort}
                    refusing={row().disabled}
                    note={row().note}
                    onSelect={() => props.onSelectEffort(level)}
                  />
                )}
              </Show>
            )}
          </For>
        </Picker>
      </Show>

      {/* Nothing here says where the list came from. A cached list is the
          agent's own answer from the last time anything asked, and it is right
          almost always; standing in the bar to say so made the provenance a
          permanent fixture of a surface that is supposed to show its plumbing
          only when something has actually gone wrong. A row the agent has since
          dropped fails the send, with a sentence, which is the moment it
          matters. */}
      <Show when={props.modelPending || props.effortPending}>
        <span class={`${styles.barNote} ${styles.barNotePending}`}>Applies from the next turn.</span>
      </Show>
    </>
  );
}
