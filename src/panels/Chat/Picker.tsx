import { Show, createSignal, createUniqueId, type Component, type JSX } from "solid-js";
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
  /** Refusing, but still focusable. A bare `disabled` takes the pill out of the
   *  tab order and its `describedBy` reason with it, which is the one thing a
   *  control the agent has turned down must not do. */
  ariaDisabled?: boolean;
  /** An element whose text describes this pill, announced on focus. */
  describedBy?: string;
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
        // Refused rather than unreachable: the pill still takes focus and still
        // says why, it just has no menu to offer.
        if (next && props.ariaDisabled) return;
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
          [styles.pillRefusing]: !!props.ariaDisabled,
        }}
        aria-label={props.ariaLabel}
        label={props.tooltip}
        // The menu is the better answer to "what is this pill", and it is
        // covering the pill anyway: a tooltip arriving on top of an open menu is
        // the same sentence twice, over the rows being read.
        suppressed={open()}
        disabled={props.disabled}
        aria-disabled={props.ariaDisabled || undefined}
        aria-describedby={props.describedBy}
        // Kobalte writes these on the trigger, which is the wrapper, and they
        // cannot be taken off it (`wrapper` removes its `role` and tab stop, not
        // its ARIA). The pill is what the keyboard reaches, so it says this too.
        aria-haspopup="menu"
        aria-expanded={open()}
      >
        <PillBody icon={props.icon} prefix={props.prefix} value={props.value} />
      </Tooltip>
    </Dropdown>
  );
}

function PillBody(props: {
  icon: Component<{ size?: number | string }>;
  prefix?: string;
  value: string;
}) {
  return (
    <>
      <Icon icon={props.icon} size={15} class={styles.pillIcon} />
      <Show when={props.prefix}>{(p) => <span class={styles.pillPrefix}>{p()}</span>}</Show>
      <span class={styles.pillValue}>{props.value}</span>
      <span class={styles.pillCaret} aria-hidden="true">
        <Icon icon={ChevronDown} size={15} />
      </span>
    </>
  );
}

/**
 * The same pill, for a control whose choices are a panel rather than a menu.
 *
 * The model palette is a surface of its own, mounted by the caller, so there is
 * no menu here to hold open. What this does hand back is the button element:
 * the panel hangs off it, and a press on it is this control's own to interpret
 * rather than an outside dismissal.
 */
export function PickerButton(props: {
  icon: Component<{ size?: number | string }>;
  prefix?: string;
  value: string;
  ariaLabel: string;
  tooltip?: string;
  disabled?: boolean;
  pending?: boolean;
  attention?: boolean;
  /** Whether the caller's panel is on screen, for the pill's own open state. */
  open?: boolean;
  ref?: (el: HTMLButtonElement) => void;
  onOpen: () => void;
}) {
  return (
    <Tooltip
      as="button"
      type="button"
      ref={props.ref}
      class={styles.pill}
      classList={{
        [styles.pillPending]: !!props.pending,
        [styles.pillAttention]: !!props.attention,
        [styles.pillOpen]: !!props.open,
      }}
      aria-label={props.ariaLabel}
      label={props.tooltip}
      // Same rule as `Picker`: the palette this opens is a whole surface, and a
      // tooltip over it says nothing the panel does not.
      suppressed={props.open}
      disabled={props.disabled}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      onClick={() => props.onOpen()}
    >
      <PillBody icon={props.icon} prefix={props.prefix} value={props.value} />
    </Tooltip>
  );
}

/**
 * A menu row offering one choice: what it is, and whether it is the one in
 * force. The description used to have its own line under the label. It reads
 * badly in the composer's own menus, which are short lists of one-word values
 * (`low`, `high`, `Agent`, `Plan`) whose sentence is a footnote rather than the
 * thing being chosen between - four two-line rows to pick a word. So it moved
 * into the label's tooltip, still one hover away and no longer setting the
 * height of every row.
 *
 * The model palette is the case this rule was written for, and it is not this
 * component: `AgentPalette` draws its own rows, where "Opus" and "Sonnet" really
 * do need the sentence beside them.
 */
export function PickerOption(props: {
  label: string;
  /** Shown on hover and focus of the label, not as a line of its own. */
  description?: string;
  selected: boolean;
  /** A choice this agent has but cannot currently take. Refusing rather than
   *  `disabled`, so the row keeps its place in arrow navigation and the `note`
   *  beside it stays reachable: a row a screen reader skips is a row whose
   *  reason nobody hears. */
  refusing?: boolean;
  /** Why it is refused, in words the user can act on. Drawn as well as
   *  announced, since a reason only AT can reach leaves everyone else with a
   *  row that silently does nothing. */
  note?: string;
  onSelect: () => void;
}) {
  const descId = createUniqueId();
  return (
    <MenuRow
      refusing={props.refusing}
      describedBy={props.description ? descId : undefined}
      onClick={props.onSelect}
    >
      <span class={styles.pickBody} classList={{ [styles.pickRefusing]: !!props.refusing }}>
        {/* Beside the row, never above it. A menu's own rows are what is above,
            so the default `top` lands the tooltip on the choices the user is
            reading past. Kobalte's popper flips on overflow by default, so a
            menu near the right edge gets it on the left with nothing extra. */}
        <Tooltip<HTMLSpanElement>
          as="span"
          class={styles.pickName}
          label={props.description}
          placement="right"
        >
          {props.label}
        </Tooltip>
        {/* Announced as well as hovered. The tooltip is `aria-describedby` on a
            span, and a span inside a menu item is not focusable, so on its own
            the sentence would reach a pointer and nobody else. */}
        <Show when={props.description}>
          {(d) => (
            <span id={descId} class={styles.srOnly}>
              {d()}
            </span>
          )}
        </Show>
        <Show when={props.refusing && props.note}>
          {(note) => <span class={styles.pickNote}>{note()}</span>}
        </Show>
      </span>
      {/* Held whatever the state, so rows do not shift sideways as the
          selection moves down the list. */}
      <span class={styles.pickCheck} classList={{ [styles.pickCheckOn]: props.selected }} aria-hidden="true">
        <Icon icon={Check} size={15} />
      </span>
    </MenuRow>
  );
}

/**
 * A lever with two states, as one icon that swaps rather than a switch.
 *
 * The composer bar is a row of pills, and a track-and-knob switch beside them
 * reads as a settings control that wandered in: it needs its own label to say
 * what it is of, which is a second piece of text in a bar whose whole job is to
 * stay out of the way. An icon that changes glyph says both things in the space
 * of one pill.
 *
 * **The glyph carries the state, and so does the colour.** A pair that differ
 * only by a slash is a poor signal at 13px, so the on state also takes the
 * accent. Neither alone is the signal; `aria-pressed` is what a screen reader
 * reads, and it is the only one of the three that cannot be missed.
 */
export function PillToggle(props: {
  /** Shown when on, and when off. Two glyphs, not one rotated: a `zap` and a
   *  `zap-off` say more to a glance than any amount of styling one of them. */
  icon: Component<{ size?: number | string }>;
  iconOff: Component<{ size?: number | string }>;
  on: boolean;
  /** Drawn beside the glyph, for a lever whose picture does not say what it is.
   *
   *  A `zap` is fast mode to anyone who has seen it once; a generic toggle
   *  glyph on an option Sway has never heard of is a control with no name on
   *  screen at all. So the text is not a style choice - it is what a caller
   *  falls back to when it has no glyph that means anything. */
  label?: string;
  /** The lever's name. The button's only name when there is no `label`. */
  ariaLabel: string;
  /** Hover and focus text. Where the agent's own sentence about this lever goes,
   *  and where its reason goes when it is refusing. */
  tooltip?: string;
  disabled?: boolean;
  /** Refusing rather than `disabled`, so the pill keeps its focus ring and the
   *  tooltip carrying the reason stays reachable from the keyboard. */
  ariaDisabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Tooltip
      as="button"
      type="button"
      class={styles.pill}
      classList={{
        [styles.pillToggle]: !props.label,
        [styles.pillToggleOn]: props.on && !props.ariaDisabled,
        [styles.pillRefusing]: !!props.ariaDisabled,
      }}
      aria-label={props.ariaLabel}
      label={props.tooltip}
      disabled={props.disabled}
      aria-disabled={props.ariaDisabled || undefined}
      aria-pressed={props.on}
      onClick={() => !props.ariaDisabled && props.onChange(!props.on)}
    >
      <Icon icon={props.on ? props.icon : props.iconOff} size={15} class={styles.pillIcon} />
      <Show when={props.label}>{(text) => <span class={styles.pillValue}>{text()}</span>}</Show>
    </Tooltip>
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
        <Icon icon={ChevronRight} size={15} />
      </span>
    </MenuRow>
  );
}
