import { For, Show, createMemo, type Component } from "solid-js";
import { ListCheck, ListX, Settings2, ToggleLeft, ToggleRight, Zap, ZapOff } from "lucide-solid";
import Picker, { PickerOption, PillToggle } from "./Picker";
import { mirroredOptions, type ChatConfigOption, type ChatConfigValue } from "../../utils/chatTypes";

/**
 * The glyphs a toggle wears, for the levers whose meaning a shape cannot reach.
 *
 * **Decoration, keyed by the agent's own option id.** This is the shape of table
 * `[[chat.annotations]]` was retired for, so the difference matters: that one
 * decided whether a *control existed*, and a key that matched nothing produced
 * no control and said nothing about it. This one only picks a picture. A key
 * that goes stale falls through to the generic pair below, which is a duller
 * toggle rather than a missing one, and the lever still works.
 *
 * Ids are the agent's vocabulary and two agents may spell one idea differently,
 * so an entry here is never a promise that a lever exists - only that if one
 * turns up under this name, this is what it looks like.
 */
const TOGGLE_GLYPHS: Record<string, [Component<{ size?: number | string }>, Component<{ size?: number | string }>]> = {
  fast_mode: [Zap, ZapOff],
  collaboration_mode: [ListCheck, ListX],
};

const GENERIC_TOGGLE: [Component<{ size?: number | string }>, Component<{ size?: number | string }>] = [
  ToggleRight,
  ToggleLeft,
];

const glyphsFor = (id: string) => TOGGLE_GLYPHS[id] ?? GENERIC_TOGGLE;

/** A lever whose glyph means something needs no words; one falling back to the
 *  generic pair does, or it is a nameless switch on a bar of named pills. */
const needsWords = (id: string) => !(id in TOGGLE_GLYPHS);

/**
 * Every lever the agent published that Tori has no control of its own for.
 *
 * **Rendered by shape, not by name.** A select becomes the same menu pill the
 * model and mode pickers are, a boolean becomes the same switch Settings uses,
 * and the agent's own label and description are shown verbatim: Tori has no
 * other word for a lever it has never seen, and inventing one would describe an
 * option by what Tori guessed rather than by what the agent said.
 *
 * An option of a kind this build cannot render is **skipped**, never drawn as a
 * dead control. The protocol may grow shapes with no Tori counterpart, and one
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
          {(option) => <MirrorRow option={option()} barDisabled={props.disabled} onSet={props.onSet} />}
        </Show>
      )}
    </For>
  );
}

/** A select with more values than a toggle can carry, which is the menu case. */
const asSelect = (o: ChatConfigOption) => (o.kind === "select" && o.choices.length !== 2 ? o : undefined);

/**
 * The two-state levers, whatever shape the agent published them in.
 *
 * A boolean is one. So is a select with exactly two choices, and folding the
 * second into the first is still a rule about *shape*: nothing here reads the
 * option's name to decide. A menu that opens to offer two rows, one of which is
 * already selected, is a click and a decision to show a single bit.
 *
 * **Which of the two counts as "on" is the agent's own ordering**, second
 * choice wins. There is nothing else to go on: a select carries no polarity, so
 * either Tori reads the labels for words like "off" - guessing at another
 * program's vocabulary in a component whose whole rule is not to - or it takes
 * the order the agent listed them in. Agents list the default first, and "on" is
 * the one you turn *to*, so the two agree in the case that exists
 * (`collaboration_mode`: `default`, then `plan`).
 */
function asToggle(o: ChatConfigOption):
  | {
      on: boolean;
      turnOn: ChatConfigValue;
      turnOff: ChatConfigValue;
      /** The accessible name, which has to carry the value as well as the lever. */
      onLabel: string;
      /** What a pill draws when its glyph says nothing on its own. */
      shortLabel: string;
      action: string | null;
    }
  | undefined {
  if (o.kind === "boolean") {
    return {
      on: o.value,
      turnOn: true,
      turnOff: false,
      onLabel: o.name,
      shortLabel: o.name,
      action: null,
    };
  }
  if (o.kind === "select" && o.choices.length === 2) {
    const [off, on] = o.choices;
    const showing = o.current === on.value ? on : off;
    const next = o.current === on.value ? off : on;
    return {
      on: o.current === on.value,
      turnOn: on.value,
      turnOff: off.value,
      onLabel: `${o.name}: ${showing.label}`,
      shortLabel: showing.label,
      action: `Switch to ${next.label}`,
    };
  }
  return undefined;
}

/** One lever. Both shapes hang off `props.option`, so an agent that changes a
 *  lever's kind swaps the widget instead of leaving the old one behind. */
function MirrorRow(props: {
  option: ChatConfigOption;
  barDisabled: boolean;
  onSet: (configId: string, value: ChatConfigValue) => void;
}) {
  const refused = () => props.option.disabled;
  const note = () => (refused() ? props.option.note : "");
  const tooltip = () => [props.option.description, note()].filter(Boolean).join(" ") || undefined;

  const toggleTooltip = (action: string | null) =>
    [action ?? props.option.description, note()].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <Show when={asSelect(props.option)}>
        {(select) => (
          <Picker
            icon={Settings2}
            prefix={`${props.option.name}:`}
            value={select().choices.find((c) => c.value === select().current)?.label ?? select().current}
            ariaLabel={props.option.name}
            tooltip={tooltip()}
            disabled={props.barDisabled}
            ariaDisabled={refused()}
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
          <PillToggle
            icon={glyphsFor(props.option.id)[0]}
            iconOff={glyphsFor(props.option.id)[1]}
            on={toggle().on}
            label={needsWords(props.option.id) ? toggle().shortLabel : undefined}
            ariaLabel={toggle().onLabel}
            tooltip={toggleTooltip(toggle().action)}
            disabled={props.barDisabled}
            // Refused here rather than by `disabled`, which would take the pill
            // out of the tab order and the tooltip carrying its reason with it.
            ariaDisabled={refused()}
            onChange={(on) => props.onSet(props.option.id, on ? toggle().turnOn : toggle().turnOff)}
          />
        )}
      </Show>
    </>
  );
}
