import { createMemo, createSignal, Show } from "solid-js";
import { Check, ChevronsUpDown } from "lucide-solid";
import { Select as Primitive } from "../../lib/select";
import { useDialogSurface } from "../Dialog/surface";
import Icon from "../Icon/Icon";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import type { ControlSize } from "../controls";
import styles from "./Select.module.css";

/** One choice: the string the app stores, the label the user reads. */
export type SelectOption = { value: string; label: string; disabled?: boolean };

/** A labelled group of choices (AppearancePane's Bundled vs user themes). A
 *  list is either flat or grouped, never mixed: Kobalte decides "group or
 *  option" per entry by the presence of the children key, so the type keeps
 *  the two shapes apart where the primitive would quietly accept a mix. */
export type SelectGroup = { label: string; options: SelectOption[] };

/** One tab of a tabbed list (AppearancePane's Dark and Light): a strip at the
 *  top of the open listbox, and only the active tab's choices beneath it. */
export type SelectTab = { label: string; options: SelectOption[] | SelectGroup[] };

const flatten = (entries: SelectOption[] | SelectGroup[]): SelectOption[] =>
  entries.flatMap((entry) => ("options" in entry ? entry.options : [entry]));

/** The gutter between the trigger and the listbox, in px. Not a token: Kobalte
 *  takes a number and hands it to floating-ui, so it never reaches CSS and
 *  cannot read `--ui-scale`. 4px is the reference's value, same as Menu's
 *  TRIGGER_GUTTER (adr_solid_ui_reference). */
const TRIGGER_GUTTER = 4;

/**
 * The one select: Kobalte's listbox-behind-a-button behind Tori's chrome and
 * Tori's API. This is for committing one value out of a fixed list; a surface
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
 * **Tabs filter, they never commit.** With `tabs`, the listbox shows one tab's
 * choices and the trigger keeps showing the committed value even while the
 * other tab is open, so browsing is free. Every open starts on the tab that
 * holds the value.
 *
 * Chrome is split: this owns the trigger and listbox surface (in
 * `Select.module.css`), the caller's `class` adds layout (width) on the
 * trigger.
 */
export default function Select(props: {
  options: SelectOption[] | SelectGroup[];
  /** Replaces `options` with a tabbed list; `options` is ignored when set. */
  tabs?: SelectTab[];
  /** Names the tab strip for assistive tech. */
  tabsLabel?: string;
  value: string;
  onChange: (value: string) => void;
  size?: ControlSize;
  /** Shown while `value` names no option. */
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** The trigger button, for callers that move focus onto the control
   *  (DebugTargetDialog focuses the script picker when its mode appears). */
  ref?: (el: HTMLButtonElement) => void;
}) {
  // Every tab's choices, always. Kobalte answers a change of `options` by
  // re-committing the selection and closing, so a tab switch must not change
  // what it is given: the other tabs' rows stay in the collection, disabled so
  // the keyboard skips them, and hidden.
  const entries = createMemo(
    () =>
      (props.tabs ? props.tabs.flatMap((t): (SelectOption | SelectGroup)[] => t.options) : props.options) as
        | SelectOption[]
        | SelectGroup[],
  );
  const flat = createMemo<SelectOption[]>(() => flatten(entries()));
  const selected = createMemo(() => flat().find((o) => o.value === props.value) ?? null);

  const tabOf = createMemo(() => {
    const owner = new Map<SelectOption | SelectGroup, number>();
    props.tabs?.forEach((t, i) => {
      for (const entry of t.options) {
        owner.set(entry, i);
        if ("options" in entry) for (const option of entry.options) owner.set(option, i);
      }
    });
    return owner;
  });
  const valueTab = () => (selected() ? (tabOf().get(selected()!) ?? 0) : 0);
  const [tab, setTab] = createSignal(valueTab());
  const offTab = (entry: SelectOption | SelectGroup) => props.tabs != null && tabOf().get(entry) !== tab();

  const dialogSurface = useDialogSurface();

  return (
    <Primitive.Root<SelectOption, SelectGroup>
      options={entries()}
      onOpenChange={() => setTab(valueTab())}
      optionValue="value"
      optionTextValue="label"
      optionDisabled={(option) => !!option.disabled || offTab(option)}
      optionGroupChildren="options"
      value={selected()}
      onChange={(option) => {
        // Null is Kobalte clearing the selection, a state Tori's selects do not
        // have (disallowEmptySelection below); dropping it keeps the caller's
        // signal always naming a real option.
        if (option) props.onChange(option.value);
      }}
      disallowEmptySelection
      placeholder={props.placeholder}
      disabled={props.disabled}
      gutter={TRIGGER_GUTTER}
      sectionComponent={(section) => (
        <Primitive.Section class={styles.section} hidden={offTab(section.section.rawValue)}>
          {section.section.rawValue.label}
        </Primitive.Section>
      )}
      itemComponent={(item) => (
        <Primitive.Item item={item.item} class={styles.item} hidden={offTab(item.item.rawValue)}>
          <Primitive.ItemLabel class={styles.itemLabel}>{item.item.rawValue.label}</Primitive.ItemLabel>
          <Primitive.ItemIndicator class={styles.check}>
            <Icon icon={Check} />
          </Primitive.ItemIndicator>
        </Primitive.Item>
      )}
    >
      <Primitive.Trigger
        class={[styles.trigger, styles[props.size ?? "md"], props.class].filter(Boolean).join(" ")}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        ref={props.ref}
      >
        <Primitive.Value<SelectOption> class={styles.value}>{(state) => state.selectedOption().label}</Primitive.Value>
        <Primitive.Icon class={styles.caret}>
          <Icon icon={ChevronsUpDown} />
        </Primitive.Icon>
      </Primitive.Trigger>
      {/* Mounted into the enclosing dialog's panel when there is one (the
          debug-target picker), to document.body otherwise; same call Dropdown
          makes, and for the same reason. */}
      <Primitive.Portal mount={dialogSurface()}>
        <Primitive.Content class={styles.content} classList={{ [styles.tabbed]: !!props.tabs }}>
          <Show when={props.tabs}>
            {(tabs) => (
              <SegmentedControl
                class={styles.tabs}
                size="sm"
                options={tabs().map((t, i) => ({ value: String(i), label: t.label }))}
                value={String(tab())}
                onChange={(i) => setTab(Number(i))}
                aria-label={props.tabsLabel}
              />
            )}
          </Show>
          <Primitive.Listbox class={styles.listbox} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
