import { createMemo } from "solid-js";
import { Check, ChevronsUpDown } from "lucide-solid";
import { Select as Primitive } from "../../lib/select";
import { useDialogSurface } from "../Dialog/surface";
import Icon from "../Icon/Icon";
import type { ControlSize } from "../controls";
import styles from "./Select.module.css";

/** One choice: the string the app stores, the label the user reads. */
export type SelectOption = { value: string; label: string; disabled?: boolean };

/** A labelled group of choices (AppearancePane's Bundled vs user themes). A
 *  list is either flat or grouped, never mixed: Kobalte decides "group or
 *  option" per entry by the presence of the children key, so the type keeps
 *  the two shapes apart where the primitive would quietly accept a mix. */
export type SelectGroup = { label: string; options: SelectOption[] };

/** The gutter between the trigger and the listbox, in px. Not a token: Kobalte
 *  takes a number and hands it to floating-ui, so it never reaches CSS and
 *  cannot read `--ui-scale`. 4px is the reference's value, same as Menu's
 *  TRIGGER_GUTTER (adr_solid_ui_reference). */
const TRIGGER_GUTTER = 4;

/**
 * The one select: Kobalte's listbox-behind-a-button behind Sway's chrome and
 * Sway's API. This is for committing one value out of a fixed list; a surface
 * whose rows carry actions is a menu (`Menu/`), and a filterable picker is the
 * Omnibox's business.
 *
 * **String in, string out.** Kobalte's controlled `value`/`onChange` traffic in
 * the option *object*, so the wrapper keeps a memo from the caller's string to
 * the owning option and back. The memos re-run when `props.options` changes,
 * which is what keeps a reactive list (AppearancePane's themes arriving from a
 * folder watcher) live in the open listbox - a setup-time snapshot here would
 * pin the first list forever.
 *
 * **An unknown value renders empty, deliberately.** When `props.value` names no
 * option, Kobalte gets `null` and the trigger shows nothing. The one caller
 * with an unstable value space (AppearancePane) already resolves unknown ids to
 * its own default *before* this prop, and that is the right place: only the
 * call site knows what an absent value means.
 *
 * **Labeling is the call site's.** The trigger is a button, so it has no
 * `<label for>` to inherit; every consumer passes `aria-label` or points
 * `aria-labelledby` at its visible label (the settings rows via `rowLabelId`).
 *
 * Chrome is split: this owns the trigger and listbox surface (in
 * `Select.module.css`), the caller's `class` adds layout (width) on the
 * trigger.
 */
export default function Select(props: {
  options: SelectOption[] | SelectGroup[];
  value: string;
  onChange: (value: string) => void;
  size?: ControlSize;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** The trigger button, for callers that move focus onto the control
   *  (DebugTargetDialog focuses the script picker when its mode appears). */
  ref?: (el: HTMLButtonElement) => void;
}) {
  const flat = createMemo<SelectOption[]>(() =>
    props.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])),
  );
  const selected = createMemo(() => flat().find((o) => o.value === props.value) ?? null);

  const dialogSurface = useDialogSurface();

  return (
    <Primitive.Root<SelectOption, SelectGroup>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      optionGroupChildren="options"
      value={selected()}
      onChange={(option) => {
        // Null is Kobalte clearing the selection, a state Sway's selects do not
        // have (disallowEmptySelection below); dropping it keeps the caller's
        // signal always naming a real option.
        if (option) props.onChange(option.value);
      }}
      disallowEmptySelection
      disabled={props.disabled}
      gutter={TRIGGER_GUTTER}
      sectionComponent={(section) => (
        <Primitive.Section class={styles.section}>
          {section.section.rawValue.label}
        </Primitive.Section>
      )}
      itemComponent={(item) => (
        <Primitive.Item item={item.item} class={styles.item}>
          <Primitive.ItemLabel class={styles.itemLabel}>
            {item.item.rawValue.label}
          </Primitive.ItemLabel>
          <Primitive.ItemIndicator class={styles.check}>
            <Icon icon={Check} />
          </Primitive.ItemIndicator>
        </Primitive.Item>
      )}
    >
      <Primitive.Trigger
        class={[styles.trigger, styles[props.size ?? "md"], props.class]
          .filter(Boolean)
          .join(" ")}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        ref={props.ref}
      >
        <Primitive.Value<SelectOption> class={styles.value}>
          {(state) => state.selectedOption().label}
        </Primitive.Value>
        <Primitive.Icon class={styles.caret}>
          <Icon icon={ChevronsUpDown} />
        </Primitive.Icon>
      </Primitive.Trigger>
      {/* Mounted into the enclosing dialog's panel when there is one (the
          debug-target picker), to document.body otherwise; same call Dropdown
          makes, and for the same reason. */}
      <Primitive.Portal mount={dialogSurface()}>
        <Primitive.Content class={styles.content}>
          <Primitive.Listbox class={styles.listbox} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
