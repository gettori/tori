import {
  createEffect,
  createSignal,
  createUniqueId,
  mergeProps,
  onCleanup,
  Show,
  splitProps,
  untrack,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { anchorLayer, openLayer } from "../../lib/layer";
import { callHandler, type TriggerHandler } from "../callHandler";
import { useDialogSurface } from "../Dialog/surface";
import styles from "./Tooltip.module.css";

/** Which side of the control the tooltip sits on. */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

/** At 500 a tooltip opened while the pointer was only passing over its control
 *  on the way to a neighbour, and covered it. */
const OPEN_DELAY = 700;
/** A lingering tooltip sat over the neighbouring control the pointer was
 *  heading for. */
const CLOSE_DELAY = 0;

/** How far the tooltip sits off its trigger. Enough to clear the trigger's own
 *  focus ring, which a flush tooltip sits on top of. */
const GUTTER = 4;

/** Generic in the trigger element so a caller's own handlers keep their element
 *  type: `onClick` on a `Button` is typed against `HTMLButtonElement`, and a
 *  props interface fixed to `HTMLElement` would reject it. `ButtonHTMLAttributes`
 *  as the base rather than the plain HTML set because ~130 of the ticket's 134
 *  triggers are buttons; the handful that are not (`label`, `input`) name their
 *  element - `<Tooltip<HTMLLabelElement> as="label" …>`.
 *
 *  Generic in `P` as well, the props of a *component* host. It is `{}` for the
 *  tag-name hosts that are the overwhelming majority, and inferred from `as`
 *  when a component is passed, which is what makes that component's own
 *  required props required here - see the `as` field below. `as` and `children`
 *  are dropped from `P` because this component owns both: the host's `as` would
 *  otherwise intersect with this one's and admit nothing. */
export type TooltipProps<T extends HTMLElement = HTMLButtonElement, P extends Record<string, any> = {}> = Omit<
  JSX.ButtonHTMLAttributes<T>,
  "type" | "title"
> &
  Omit<P, "as" | "children"> & {
    /** Narrower than the native attribute, which Solid still types with the
     *  long-dead `"menu"` value. */
    type?: "submit" | "reset" | "button";
    /** The tooltip text. Rendered as the control's *description*
     *  (`aria-describedby`), never as its name - see the module comment.
     *
     *  Absent renders the bare control and no tooltip machinery at all, which is
     *  what lets `Button`, `IconButton` and `Tab` pass their own optional
     *  `tooltip` prop straight through instead of carrying two render paths and
     *  the drift between them. */
    label?: JSX.Element;
    /** Hold the tooltip shut while something else is speaking for this control.
     *
     *  For a trigger that also opens a menu or a panel: the surface it opened is
     *  the answer to "what is this", and a tooltip sitting over it is the same
     *  sentence twice, on top of the thing the user is reading. The usual case is
     *  not a tooltip arriving late but one **already up** - the pointer rested
     *  long enough to open it, and the click that opens the menu comes after.
     *
     *  Not `label={undefined}`: that path renders the bare control, so toggling
     *  it would unmount and rebuild the trigger at the moment it is being
     *  clicked. */
    suppressed?: boolean;
    placement?: TooltipPlacement;
    openDelay?: number;
    closeDelay?: number;
    /** What element the tooltip portals into.
     *
     *  Defaults to the enclosing dialog's panel when there is one, and to
     *  `document.body` otherwise, so an in-dialog tooltip needs nothing at the
     *  call site. A modal hides what is outside its panel from assistive tech,
     *  see `../Dialog/surface.ts`.
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
    /** The element the trigger renders as. Either a tag name, or a component
     *  whose props then have to be passed here too.
     *
     *  Whichever it is, the trigger has to *be* the control (see the module
     *  comment), so this is a host to render, never a child to wrap. Tori's own
     *  controls still compose this from the inside rather than passing themselves
     *  in; the component form exists for the case they cannot cover, a control
     *  that is itself a headless primitive's part. `IconGrid`'s tiles are the
     *  first: the control is a `ToggleGroup.Item`, which only the toggle group's
     *  context can supply, so `Button`'s trick of wrapping a plain `button` from
     *  the inside is not available.
     *
     *  **A component host's own props are required here.** `P` is inferred from
     *  this field, so `<Tooltip as={ToggleGroup.ButtonItem}>` without the `value`
     *  that item needs is a type error. Without that, `ButtonHTMLAttributes` would
     *  quietly satisfy it - it declares an optional `value` of its own - and the
     *  grid would compile and then register every tile under the same undefined
     *  key. Inference needs a *concrete* component, which is why `toggle-group.ts`
     *  hands out a pinned `ButtonItem` beside the generic `Item`. A host has to
     *  forward `ref` and the pointer and focus handlers to its element.
     *
     *  **Button-shaped tags only, in practice.** These props extend
     *  `ButtonHTMLAttributes`, so an attribute belonging to some other element -
     *  an `input`'s `placeholder`, a `label`'s `for` - is a type error here. The
     *  two sets cannot simply be merged either: a type combining both
     *  `ButtonHTMLAttributes` and `InputHTMLAttributes` declares the same names at
     *  different types and admits nothing. A non-button control that wants a
     *  description is usually better served by `aria-describedby` and a
     *  visually-hidden hint - which is what the search box does, and why it reads
     *  better there than a tooltip would. */
    as?: keyof JSX.HTMLElementTags | Component<P>;
    children?: JSX.Element;
  };

// Its own component so these effects run after the portal has connected it:
// showPopover throws on a node that is not in the document.
function TooltipSurface(props: {
  id: string;
  anchor: HTMLElement;
  placement: TooltipPlacement;
  onDismiss: () => void;
  children: JSX.Element;
}) {
  let content!: HTMLDivElement;
  createEffect(() =>
    untrack(() => {
      const unanchor = anchorLayer(props.anchor, content, props.placement, GUTTER);
      const release = openLayer({
        element: content,
        show: () => content.showPopover(),
        hide: () => content.hidePopover(),
        onDismiss: () => props.onDismiss(),
        passive: true,
      });
      onCleanup(() => {
        release();
        unanchor();
      });
    }),
  );
  return (
    <div ref={content} id={props.id} popover="manual" role="tooltip" data-expanded="" class={styles.content}>
      {props.children}
    </div>
  );
}

/**
 * The one tooltip surface. Everything not listed below is a native attribute
 * and lands on the trigger, so a call site reads as the control it already was
 * plus a `label`.
 *
 * **The trigger is the control, never a wrapper.** Solid does not delegate
 * `focus` and `focus` does not bubble, so a trigger wrapped around the control
 * would receive neither the description nor the keyboard opening, and would
 * look correct on hover while being unreachable by keyboard. That is why `as`
 * names a host for this component to render, rather than accepting a built
 * control as a child: a Solid JSX element is already-constructed DOM, and
 * nothing can inject the trigger's props into it after the fact.
 *
 * **A tooltip is a description, not a name.** A description is announced after
 * the name and skipped by some verbosity settings. A control whose only text is
 * its tooltip therefore still needs an `aria-label`, which is why `Button`,
 * `IconButton` and `Tab` backfill the name from their `tooltip` prop and this
 * component does not: it cannot know whether its trigger has visible text.
 *
 * **`title` is a type error here, deliberately.** The two say the same thing to
 * a mouse and only one of them says anything to a keyboard.
 * `src/test/interactiveTitle.test.ts` guards everything the type cannot see.
 * (Spelling the attribute out here would trip that guard: it counts prose too.)
 *
 * **`whenDisabled`.** A `disabled` button fires no pointer events and takes no
 * focus, so the only way to reach its tooltip is an enabled element around it:
 * a span whose pointer events drive the same open state. jsdom dispatches
 * pointer events on a disabled button anyway, so a test asserting "opens while
 * disabled" would pass with the span removed.
 */
export default function Tooltip<T extends HTMLElement = HTMLButtonElement, P extends Record<string, any> = {}>(
  props: TooltipProps<T, P>,
) {
  const [local, handlers, trigger] = splitProps(
    props,
    ["label", "suppressed", "placement", "openDelay", "closeDelay", "mount", "whenDisabled", "as"],
    ["ref", "onPointerEnter", "onPointerLeave", "onPointerDown", "onClick", "onFocus", "onBlur"],
  );

  const openDelay = () => local.openDelay ?? OPEN_DELAY;
  const closeDelay = () => local.closeDelay ?? CLOSE_DELAY;
  const dialogSurface = useDialogSurface();
  const mount = () => local.mount ?? dialogSurface();
  const id = createUniqueId();

  const [isOpen, setOpen] = createSignal(false);
  const [triggerEl, setTriggerEl] = createSignal<HTMLElement>();
  const shown = () => isOpen() && !local.suppressed;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerDown = false;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (next: boolean, delay: number) => {
    clearTimer();
    timer = setTimeout(() => setOpen(next), delay);
  };
  const closeNow = () => {
    clearTimer();
    setOpen(false);
  };
  const onPointerUp = () => {
    pointerDown = false;
  };
  onCleanup(() => {
    clearTimer();
    document.removeEventListener("pointerup", onPointerUp);
  });

  // Cleared rather than masked, so lifting suppression cannot spring it back.
  createEffect(() => {
    if (local.suppressed) closeNow();
  });

  const behaviour = {
    type: "button",
    ref: (el: HTMLElement) => {
      setTriggerEl(el);
      (handlers.ref as ((el: HTMLElement) => void) | undefined)?.(el);
    },
    get "aria-describedby"() {
      return shown() ? id : undefined;
    },
    get "data-expanded"() {
      return shown() ? "" : undefined;
    },
    get "data-closed"() {
      return shown() ? undefined : "";
    },
    onPointerEnter: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerEnter as TriggerHandler);
      if (e.pointerType === "touch" || local.suppressed || e.defaultPrevented) return;
      if (isOpen()) clearTimer();
      else schedule(true, openDelay());
    },
    onPointerLeave: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerLeave as TriggerHandler);
      if (e.pointerType === "touch") return;
      if (isOpen()) schedule(false, closeDelay());
      else clearTimer();
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, handlers.onPointerDown as TriggerHandler);
      pointerDown = true;
      document.addEventListener("pointerup", onPointerUp, { once: true });
    },
    onClick: (e: MouseEvent) => {
      callHandler(e, handlers.onClick as TriggerHandler);
      closeNow();
    },
    onFocus: (e: FocusEvent) => {
      callHandler(e, handlers.onFocus as TriggerHandler);
      if (local.suppressed || e.defaultPrevented || pointerDown) return;
      clearTimer();
      setOpen(true);
    },
    onBlur: (e: FocusEvent) => {
      callHandler(e, handlers.onBlur as TriggerHandler);
      closeNow();
    },
  };

  // The cast is confined to these two lines: `T` buys the caller precise handler
  // types, and `Dynamic` resolves its props from a tag name it cannot know here.
  const bareProps = mergeProps(handlers, trigger) as unknown as TooltipProps<HTMLButtonElement>;
  const triggerProps = mergeProps(behaviour, trigger) as unknown as TooltipProps<HTMLButtonElement>;

  const control = () => <Dynamic component={local.as ?? "button"} {...triggerProps} />;

  return (
    <Show
      when={local.label != null}
      // No label, no tooltip: the bare control. This is what a wrapper's
      // untooltipped call sites get, and there are hundreds of them.
      fallback={<Dynamic component={local.as ?? "button"} {...bareProps} />}
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
      <Show when={shown() && triggerEl()}>
        {(anchor) => (
          <Portal mount={mount()}>
            <TooltipSurface id={id} anchor={anchor()} placement={local.placement ?? "top"} onDismiss={closeNow}>
              {local.label}
            </TooltipSurface>
          </Portal>
        )}
      </Show>
    </Show>
  );
}
