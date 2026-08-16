import { For, Show, createUniqueId } from "solid-js";
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
  return (
    <For each={mirroredOptions(props.options)}>
      {(option) => {
        if (option.kind === "select") {
          // The agent's label for the value it reports, falling back to the id
          // itself: a current value missing from its own list is a real
          // possibility, and the raw id says more than an empty pill.
          const shown =
            option.choices.find((c) => c.value === option.current)?.label ?? option.current;
          return (
            <Picker
              icon={Settings2}
              prefix={`${option.name}:`}
              value={shown}
              ariaLabel={option.name}
              tooltip={option.description}
              disabled={props.disabled}
            >
              <For each={option.choices}>
                {(choice) => (
                  <PickerOption
                    label={choice.label}
                    description={choice.description}
                    selected={choice.value === option.current}
                    onSelect={() => props.onSet(option.id, choice.value)}
                  />
                )}
              </For>
            </Picker>
          );
        }
        if (option.kind === "boolean") {
          // Not the agent's id: two chats can be mounted at once, both
          // publishing an option called `web_search`, and `aria-describedby`
          // would then point at whichever rendered first.
          const hintId = createUniqueId();
          return (
            <span class={styles.barToggle}>
              <Switch
                checked={option.value}
                onChange={(on) => props.onSet(option.id, on)}
                disabled={props.disabled}
                label={option.name}
                aria-describedby={option.description ? hintId : undefined}
              />
              {/* Announced, never drawn: the agent's own sentence about what
                  this toggle does, which the pill controls have room for in a
                  tooltip and a switch does not. */}
              <Show when={option.description}>
                <span id={hintId} class={styles.srOnly}>
                  {option.description}
                </span>
              </Show>
            </span>
          );
        }
        return null;
      }}
    </For>
  );
}
