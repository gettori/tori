import { Show, createSignal, type Component, type JSX } from "solid-js";
import { Check, ChevronDown, ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Dropdown from "../../components/Menu/Dropdown";
import { MenuRow } from "../../components/Menu/rows";
import Tooltip from "../../components/Tooltip/Tooltip";
import styles from "./Chat.module.css";

/**
 * One composer control: a pill that opens the app's own menu.
 *
 * The three session controls (mode, model, effort) are the same object with
 * different contents, so the trigger, the anchoring and the open state live here
 * once. They render through `<Menu>` rather than a native `<select>` stretched
 * invisibly over a chip, which is what they used to be: the platform menu came
 * with the platform's look, so the one surface in the app that is *most* about
 * choosing was the one surface that did not look like the app.
 *
 * Opens upward. The composer sits at the bottom of the pane, so a menu placed
 * below its trigger would have nowhere to go but back over it.
 */
export default function Picker(props: {
  icon: Component<{ size?: number | string }>;
  /** A quiet lead-in inside the pill ("Thinking:"), when the value alone would
   *  not say what it is a value *of*. */
  prefix?: string;
  value: string;
  ariaLabel: string;
  /** Hover/focus text for the pill. Named `tooltip`, not `title`: a native
   *  `title` never reaches the keyboard (issue 102). */
  tooltip?: string;
  disabled?: boolean;
  /** The shown value is a pick that has not reached a turn boundary yet. */
  pending?: boolean;
  /** The shown value is one the user should keep noticing, for as long as it is
   *  in force. Styling only: whatever it means is the caller's to say. */
  attention?: boolean;
  /** Menu contents. Rows commit and close on their own through `MenuRow`. */
  children: JSX.Element;
  /** Called as the menu closes, for a caller holding page state inside it. */
  onClose?: () => void;
}) {
  const [open, setOpen] = createSignal(false);

  return (
    // The pill belongs to its `Tooltip`, so the menu wraps it rather than being
    // it. The wrapper keeps a box, since a dropdown is anchored on its trigger's
    // rect; `display: contents` would leave it with none and open the menu in
    // the corner of the window.
    <Dropdown
      as="span"
      wrapper
      class={styles.pillMenu}
      open={open()}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) props.onClose?.();
      }}
      // Above the pill, and left-aligned to it, so the menu reads as belonging
      // to this control rather than to the bar. Kobalte flips it back down on
      // its own if the space above ever runs out, which is what the old viewport
      // clamp could only do by dragging the menu over the trigger.
      placement="top-start"
      menu={props.children}
    >
      <Tooltip
        as="button"
        type="button"
        class={styles.pill}
        classList={{
          [styles.pillPending]: !!props.pending,
          [styles.pillAttention]: !!props.attention,
          [styles.pillOpen]: open(),
        }}
        aria-label={props.ariaLabel}
        label={props.tooltip}
        disabled={props.disabled}
        // Kobalte writes these on the trigger, which is the wrapper, and they
        // cannot be taken off it (`wrapper` removes its `role` and tab stop, not
        // its ARIA). The pill is what the keyboard reaches, so it says this too.
        aria-haspopup="menu"
        aria-expanded={open()}
      >
        <Icon icon={props.icon} size={13} class={styles.pillIcon} />
        <Show when={props.prefix}>{(p) => <span class={styles.pillPrefix}>{p()}</span>}</Show>
        <span class={styles.pillValue}>{props.value}</span>
        <span class={styles.pillCaret} aria-hidden="true">
          <Icon icon={ChevronDown} size={13} />
        </span>
      </Tooltip>
    </Dropdown>
  );
}

/**
 * A menu row offering one choice: what it is, what it is for, and whether it is
 * the one in force. The description earns its line - "Opus" and "Sonnet" do not
 * tell anyone which to reach for, and the catalogue already carries the sentence
 * that does.
 */
export function PickerOption(props: {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <MenuRow onClick={props.onSelect}>
      <span class={styles.pickBody}>
        <span class={styles.pickName}>{props.label}</span>
        <Show when={props.description}>{(d) => <span class={styles.pickDesc}>{d()}</span>}</Show>
      </span>
      {/* Held whatever the state, so rows do not shift sideways as the
          selection moves down the list. */}
      <span class={styles.pickCheck} classList={{ [styles.pickCheckOn]: props.selected }} aria-hidden="true">
        <Icon icon={Check} size={14} />
      </span>
    </MenuRow>
  );
}

/** A row that leads to another page of the same menu, rather than choosing. */
export function PickerMore(props: { label: string; onOpen: () => void }) {
  return (
    <MenuRow closeOnSelect={false} onClick={props.onOpen}>
      <span class={styles.pickBody}>
        <span class={styles.pickName}>{props.label}</span>
      </span>
      <span class={styles.pickInto} aria-hidden="true">
        <Icon icon={ChevronRight} size={14} />
      </span>
    </MenuRow>
  );
}
