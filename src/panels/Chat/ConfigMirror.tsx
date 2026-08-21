import { For, Show, createMemo, createUniqueId } from "solid-js";
import { Settings2 } from "lucide-solid";
import Picker, { PickerOption } from "./Picker";
import Switch from "../../components/Switch/Switch";
import { mirroredOptions, type ChatConfigOption, type ChatConfigValue } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

/**
 * Every lever the agent published that Sway has no control of its own for.
 *
 * **Rendered by shape, not by name.** A select becomes the same menu pill the
 * model and mode pickers are, a boolean becomes the same switch Settings uses,
 * and the agent's own label and description are shown verbatim: Sway has no
 * other word for a lever it has never seen, and inventing one would describe an
 * option by what Sway guessed rather than by what the agent said.
 *
 * An option of a kind this build cannot render is **skipped**, never drawn as a
 * dead control. The protocol may grow shapes with no Sway counterpart, and one
 * row fewer is a better answer than a widget that does nothing when clicked.
 *
 * There is no pending state here, unlike the mode. A mirrored switch goes out
 * the moment it is flipped, and the agent answers it with its whole option set,
 * so what these controls show is always what the agent last reported.
 */
export default function ConfigMirror(props: {
  options: readonly ChatConfigOption[];
  disabled: boolean;
  onSet: (configId: string, value: ChatConfigValue) => void;
}) {
  // Deduped by id, because a switch travels as an id: two rows sharing one
  // would be two controls writing a lever neither could address separately.
  const shown = createMemo(() => {
    const seen = new Set<string>();
    return mirroredOptions(props.options).filter((o) => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });
  });

  // Keyed by the agent's own id, never by the option object. The whole set is
  // replaced on every answer, so keying on identity rebuilds the row the user
  // is standing on and takes their focus down with it.
  return (
    <For each={shown().map((o) => o.id)}>
      {(id) => (
        <Show when={shown().find((o) => o.id === id)}>
          {(option) => (
            <MirrorRow option={option()} barDisabled={props.disabled} onSet={props.onSet} />
          )}
        </Show>
      )}
    </For>
  );
}

const asSelect = (o: ChatConfigOption) => (o.kind === "select" ? o : undefined);
const asToggle = (o: ChatConfigOption) => (o.kind === "boolean" ? o : undefined);

/** One lever. Both shapes hang off `props.option`, so an agent that changes a
 *  lever's kind swaps the widget instead of leaving the old one behind. */
function MirrorRow(props: {
  option: ChatConfigOption;
  /** The whole bar is out of action (a refused session, a draft mid-send).
   *  Not the same as the agent refusing this one lever, which has a reason. */
  barDisabled: boolean;
  onSet: (configId: string, value: ChatConfigValue) => void;
}) {
  // Not the agent's id: two chats can be mounted at once, both publishing an
  // option called `web_search`, and `aria-describedby` would then point at
  // whichever rendered first.
  const hintId = createUniqueId();
  const noteId = createUniqueId();
  const refused = () => props.option.disabled;
  const note = () => (refused() ? props.option.note : "");
  const describes = (ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <>
      <Show when={asSelect(props.option)}>
        {(select) => (
          <Picker
            icon={Settings2}
            prefix={`${props.option.name}:`}
            // The agent's label for the value it reports, falling back to the id
            // itself: a current value missing from its own list is a real
            // possibility, and the raw id says more than an empty pill.
            value={
              select().choices.find((c) => c.value === select().current)?.label ?? select().current
            }
            ariaLabel={props.option.name}
            tooltip={props.option.description}
            disabled={props.barDisabled}
            ariaDisabled={refused()}
            describedBy={describes([!!note() && noteId])}
          >
            <For each={select().choices}>
              {(choice) => (
                <PickerOption
                  label={choice.label}
                  description={choice.description}
                  selected={choice.value === select().current}
                  onSelect={() => props.onSet(props.option.id, choice.value)}
                />
              )}
            </For>
          </Picker>
        )}
      </Show>

      <Show when={asToggle(props.option)}>
        {(toggle) => (
          <span class={styles.barToggle}>
            <Switch
              checked={toggle().value}
              // Refused here rather than by `disabled`, which would take the
              // switch out of the tab order and its reason with it.
              onChange={(on) => !refused() && props.onSet(props.option.id, on)}
              disabled={props.barDisabled}
              aria-disabled={refused()}
              label={props.option.name}
              aria-describedby={describes([!!props.option.description && hintId, !!note() && noteId])}
            />
            {/* Announced, never drawn: the agent's own sentence about what this
                toggle does, which the pill controls have room for in a tooltip
                and a switch does not. */}
            <Show when={props.option.description}>
              <span id={hintId} class={styles.srOnly}>
                {props.option.description}
              </span>
            </Show>
          </span>
        )}
      </Show>

      {/* Drawn as well as announced. A refusal only a screen reader can hear
          leaves everyone else with a control that silently does nothing. */}
      <Show when={note()}>
        {(reason) => (
          <span id={noteId} class={styles.barNote}>
            {reason()}
          </span>
        )}
      </Show>
    </>
  );
}
