import { Show, createSignal, type Component, type JSX } from "solid-js";
import { Check, ChevronDown, ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Menu, { MenuRow } from "../../components/Menu/Menu";
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
 * below its trigger would be dragged back over the trigger by the viewport
 * clamp.
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
  const [at, setAt] = createSignal<{ x: number; y: number } | null>(null);
  let trigger: HTMLButtonElement | undefined;

  function close() {
    setAt(null);
    props.onClose?.();
  }

  function toggle() {
    if (at()) return close();
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    // Left edge of the trigger, and its top as the line the menu sits above, so
    // the menu reads as belonging to this pill rather than to the bar.
    setAt({ x: r.left, y: r.top - 6 });
  }

  return (
    <>
      <Tooltip
        as="button"
        ref={trigger}
        type="button"
        class={styles.pill}
        classList={{
          [styles.pillPending]: !!props.pending,
          [styles.pillAttention]: !!props.attention,
          [styles.pillOpen]: !!at(),
        }}
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={!!at()}
        label={props.tooltip}
        disabled={props.disabled}
        onClick={toggle}
      >
        <Icon icon={props.icon} size={13} class={styles.pillIcon} />
        <Show when={props.prefix}>{(p) => <span class={styles.pillPrefix}>{p()}</span>}</Show>
        <span class={styles.pillValue}>{props.value}</span>
        <span class={styles.pillCaret} aria-hidden="true">
          <Icon icon={ChevronDown} size={13} />
        </span>
      </Tooltip>
      <Show when={at()}>
        {(pos) => (
          <Menu x={pos().x} y={pos().y} openAbove anchorEl={trigger} onClose={close}>
            {props.children}
          </Menu>
        )}
      </Show>
    </>
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
    <MenuRow keepOpen onClick={props.onOpen}>
      <span class={styles.pickBody}>
        <span class={styles.pickName}>{props.label}</span>
      </span>
      <span class={styles.pickInto} aria-hidden="true">
        <Icon icon={ChevronRight} size={14} />
      </span>
    </MenuRow>
  );
}
