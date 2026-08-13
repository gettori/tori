import { createSignal, onCleanup, Show, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Tooltip as Primitive } from "../../lib/tooltip";
import { useDialogSurface } from "../Dialog/surface";
import styles from "./Tooltip.module.css";

/** Which side of the control the tooltip sits on. Kobalte accepts twelve
 *  placements (each side plus `-start`/`-end`); these four are what Sway uses,
 *  and keeping the union local is what lets this file expose a placement type
 *  without the app importing one from the primitives package - which
 *  `boundary.test.ts` would fail it for, this file included. */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

/** Slower than the 700ms Kobalte ships: 700 is what "the tooltips are slow to
 *  appear" means on a toolbar, and 500 still reads as deliberate rather than as
 *  a flicker while the pointer crosses a strip of icons. */
const OPEN_DELAY = 500;
const CLOSE_DELAY = 300;
/** Kobalte's own default, restated because it is a design decision rather than
 *  an inherited one: within 300ms of one tooltip closing, the next opens with no
 *  delay at all, so sweeping a row of icon buttons reads as one gesture instead
 *  of eight separate waits. The timer behind it is module-global inside Kobalte,
 *  so every tooltip in the app sharing this value *is* the whole grouping
 *  mechanism. */
const SKIP_DELAY = 300;

/** Generic in the trigger element so a caller's own handlers keep their element
 *  type: `onClick` on a `Button` is typed against `HTMLButtonElement`, and a
 *  props interface fixed to `HTMLElement` would reject it. `ButtonHTMLAttributes`
 *  as the base rather than the plain HTML set because ~130 of the ticket's 134
 *  triggers are buttons; the handful that are not (`label`, `input`) name their
 *  element - `<Tooltip<HTMLLabelElement> as="label" …>`. */
export interface TooltipProps<T extends HTMLElement = HTMLButtonElement>
  extends Omit<JSX.ButtonHTMLAttributes<T>, "type"> {
  /** Narrower than the native attribute, which Solid still types with the
   *  long-dead `"menu"` value. Kobalte's trigger accepts the three real ones,
   *  and nothing in Sway passes the fourth. */
  type?: "submit" | "reset" | "button";
  /** The tooltip text. Rendered as the control's *description*
   *  (`aria-describedby`), never as its name - see the module comment.
   *
   *  Absent renders the bare control and no tooltip machinery at all, which is
   *  what lets `Button`, `IconButton` and `Tab` pass their own optional
   *  `tooltip` prop straight through instead of carrying two render paths and
   *  the drift between them. */
  label?: JSX.Element;
  placement?: TooltipPlacement;
  openDelay?: number;
  closeDelay?: number;
  /** What element the tooltip portals into.
   *
   *  Defaults to the enclosing dialog's panel when there is one, and to
   *  `document.body` otherwise, so an in-dialog tooltip needs nothing at the
   *  call site. Kobalte's `Dialog.Content` calls `createHideOutside`, which sets
   *  `aria-hidden` on everything outside the panel while the dialog is open, so
   *  a body-portalled tooltip would be painted on screen and invisible to a
   *  screen reader at the same time. See `../Dialog/surface.ts`.
   *
   *  Pass this explicitly only for a surface that hides outside content without
   *  being a `Dialog`. */
  mount?: HTMLElement;
  /** Opt in to a tooltip that also opens while the control is `disabled`.
   *
   *  Off by default, and deliberately so: it wraps the control in a hover
   *  surface, which changes the DOM shape at the call site. See the section on
   *  it in the module comment for why it cannot be the default and what no test
   *  here can prove about it. */
  whenDisabled?: boolean;
  /** The element the trigger renders as. A tag name, not a component: the
   *  trigger has to *be* the control (see the module comment), and Sway's own
   *  controls compose this from the inside rather than passing themselves in. */
  as?: keyof JSX.HTMLElementTags;
  children?: JSX.Element;
}

/**
 * The one tooltip surface: Kobalte's tooltip behind Sway's chrome and Sway's
 * API. Everything not listed below is a native attribute and lands on the
 * trigger, so a call site reads as the control it already was plus a `label`.
 *
 * **The trigger is the control, never a wrapper.** Kobalte puts every tooltip
 * behaviour on `Tooltip.Trigger` itself - `aria-describedby`, `onFocus`,
 * `onPointerEnter`, `onBlur`. Solid does not delegate `focus` and `focus` does
 * not bubble, so a trigger wrapped around the control would receive neither the
 * description nor the keyboard opening, and would look correct on hover while
 * being unreachable by keyboard. That is why `as` takes a tag name and this
 * component renders the control, rather than accepting one as a child: a Solid
 * JSX element is already-constructed DOM, and nothing can inject the trigger's
 * props into it after the fact.
 *
 * **A tooltip is a description, not a name.** `aria-describedby` is what
 * Kobalte wires, and a description is announced after the name and skipped by
 * some verbosity settings. A control whose only text is its tooltip therefore
 * still needs an `aria-label` - which is why `Button`, `IconButton` and `Tab`
 * backfill the name from their `tooltip` prop and this component does not: it
 * cannot know whether its trigger has visible text.
 *
 * **`title` is still accepted, and should not be passed.** It is here only so
 * that `Button`, `IconButton` and `Tab` can keep forwarding the native
 * attribute while the app is swept over to `tooltip`; the two say the same
 * thing to a mouse and only one of them says anything to a keyboard. The rule
 * is enforced by `src/test/interactiveTitle.test.ts`, which names every
 * remaining site, rather than by this type - a type that rejected `title`
 * outright would have meant sweeping all 134 call sites in one commit.
 *
 * ## `whenDisabled`, and what no test here proves
 *
 * A `disabled` button fires no pointer events at all, so Kobalte's trigger
 * handlers never run and its tooltip cannot be reached by any means: the
 * control is also unfocusable, so the keyboard path is gone too. The only way
 * to reach it is an enabled element wrapping the control, which is what this
 * renders when `whenDisabled` is set - a span whose `pointerenter`/
 * `pointerleave` drive the tooltip's open state on their own timer.
 *
 * That state is controlled, so it bypasses Kobalte's module-global warm-up
 * timer and this tooltip does not participate in skip-delay grouping. Kobalte's
 * own requests are fed back into the same signal, so focus opening, click-to-
 * close and Escape keep working for the spells when the control is *not*
 * disabled.
 *
 * **jsdom cannot reproduce the behaviour this works around.** jsdom dispatches
 * whatever event a test tells it to, including pointer events on a disabled
 * button, so a test asserting "the tooltip opens while disabled" would pass
 * with the span removed. The tests here therefore assert only that the span and
 * its handlers exist when asked for, and the behaviour itself rests on the
 * manual walk recorded with the ticket.
 */
export default function Tooltip<T extends HTMLElement = HTMLButtonElement>(
  props: TooltipProps<T>,
) {
  const [local, trigger] = splitProps(props, [
    "label",
    "placement",
    "openDelay",
    "closeDelay",
    "mount",
    "whenDisabled",
    "as",
  ]);

  const openDelay = () => local.openDelay ?? OPEN_DELAY;
  const closeDelay = () => local.closeDelay ?? CLOSE_DELAY;
  const dialogSurface = useDialogSurface();
  const mount = () => local.mount ?? dialogSurface();

  // Only read when `whenDisabled` is set. Kobalte's own open/close requests are
  // routed through `onOpenChange` into this same signal, so the two paths agree
  // rather than fighting: the span drives it while the control is disabled, and
  // focus/click/Escape drive it while the control is not.
  const [open, setOpen] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (next: boolean, delay: number) => {
    clearTimer();
    timer = setTimeout(() => setOpen(next), delay);
  };
  onCleanup(clearTimer);

  // The trigger's props, widened for the two polymorphic hosts below.
  //
  // `T` buys the *caller* precise handler types - the whole reason this
  // component is generic - and it is exactly that precision the hosts cannot
  // accept: Kobalte types `TooltipTriggerProps` as `Omit<any, …>` and Solid's
  // `Dynamic` resolves its props from the tag name, so both demand a concrete
  // element and neither can be told which one `as` names. The cast is confined
  // to this line, and the runtime is unaffected either way: `trigger` is the
  // same props object whatever it is typed as.
  const triggerProps = trigger as TooltipProps<HTMLButtonElement>;

  const control = () => (
    <Primitive.Trigger as={local.as ?? "button"} {...triggerProps} />
  );

  return (
    <Show
      when={local.label != null}
      // No label, no tooltip: the bare control, with none of Kobalte's context,
      // popper or portal built around it. This is what a wrapper's untooltipped
      // call sites get, and there are hundreds of them - a `Tooltip.Root` per
      // button in the editor's toolbars would be paid for nothing.
      fallback={<Dynamic component={local.as ?? "button"} {...triggerProps} />}
    >
      <Primitive.Root
        placement={local.placement ?? "top"}
        openDelay={openDelay()}
        closeDelay={closeDelay()}
        skipDelayDuration={SKIP_DELAY}
        // `undefined` is how Kobalte is told this is uncontrolled, so the
        // default path keeps the grouped warm-up timer rather than this
        // component's.
        open={local.whenDisabled ? open() : undefined}
        onOpenChange={local.whenDisabled ? setOpen : undefined}
      >
        {local.whenDisabled ? (
          <span
            class={styles.hoverSurface}
            data-tooltip-hover-surface=""
            onPointerEnter={() => schedule(true, openDelay())}
            onPointerLeave={() => schedule(false, closeDelay())}
          >
            {control()}
          </span>
        ) : (
          control()
        )}
        <Primitive.Portal mount={mount()}>
          <Primitive.Content class={styles.content}>
            {local.label}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Show>
  );
}
