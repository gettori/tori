import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

type LayerSide = "top" | "bottom" | "left" | "right";
export type LayerPlacement = LayerSide | `${LayerSide}-${"start" | "end"}`;

export interface LayerOptions {
  element: HTMLElement;
  show: () => void;
  hide: () => void;
  onDismiss: () => void;
  modal?: boolean;
  returnFocus?: () => HTMLElement | null | undefined;
  ignorePress?: (target: Node) => boolean;
  passive?: boolean;
}

interface Layer extends LayerOptions {
  detach: () => void;
}

const stack: Layer[] = [];
let scrollLocks = 0;
let rootOverflow = "";
let anchorCount = 0;
let dismissingByPress = false;

const topLayer = (): Layer | undefined => stack[stack.length - 1];

function topInteractiveLayer() {
  for (let at = stack.length - 1; at >= 0; at--) {
    if (!stack[at].passive) return stack[at];
  }
  return undefined;
}

function isInside({ element }: Layer, e: PointerEvent) {
  const target = e.target as Node;
  if (target !== element) return element.contains(target);
  // A press on a modal's backdrop targets the dialog itself, outside its box.
  const box = element.getBoundingClientRect();
  return e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
}

/** For a dialog not on this stack yet, whose own Escape listener runs first. */
export function takeEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const top = topLayer();
  if (!top) return;
  // Android's close watcher closes the dialog on an Escape left unprevented,
  // and a cancel it delivers then cannot be prevented.
  e.preventDefault();
  e.stopPropagation();
  top.onDismiss();
}

function onPointerDown(e: PointerEvent) {
  const top = topInteractiveLayer();
  if (!top || isInside(top, e) || top.ignorePress?.(e.target as Node)) return;
  dismissingByPress = true;
  try {
    top.onDismiss();
  } finally {
    dismissingByPress = false;
  }
}

function lockScroll() {
  if (scrollLocks++ > 0) return;
  rootOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
}

function unlockScroll() {
  if (--scrollLocks > 0) return;
  document.documentElement.style.overflow = rootOverflow;
}

function leave(layer: Layer) {
  const at = stack.indexOf(layer);
  if (at < 0) return;
  stack.splice(at, 1);
  layer.detach();
  if (layer.modal) unlockScroll();
  if (stack.length > 0) return;
  document.removeEventListener("keydown", takeEscape);
  document.removeEventListener("pointerdown", onPointerDown, true);
}

function closedNatively(layer: Layer) {
  const at = stack.indexOf(layer);
  if (at < 0) return;
  for (const gone of stack.slice(at).reverse()) {
    leave(gone);
    gone.onDismiss();
  }
}

function watchNativeClose(layer: Layer) {
  const { element } = layer;
  const onClose = () => closedNatively(layer);
  const onToggle = (e: Event) => {
    if ((e as ToggleEvent).newState === "closed") closedNatively(layer);
  };
  const onCancel = (e: Event) => {
    // A file input inside the dialog bubbles its own cancel up to here.
    if (e.target !== element || !e.cancelable) return;
    e.preventDefault();
    topLayer()?.onDismiss();
  };
  if (element instanceof HTMLDialogElement) {
    element.addEventListener("close", onClose);
    element.addEventListener("cancel", onCancel);
  } else {
    element.addEventListener("toggle", onToggle);
  }
  return () => {
    element.removeEventListener("close", onClose);
    element.removeEventListener("cancel", onCancel);
    element.removeEventListener("toggle", onToggle);
  };
}

// WebKit does not focus a clicked button, so the press names the opener instead.
function pressedOpener() {
  const press = window.event;
  if (!(press instanceof MouseEvent) || !(press.target instanceof Element)) return null;
  return press.target.closest<HTMLElement>("button, a[href], [tabindex]");
}

export function openLayer(options: LayerOptions) {
  const focused = document.activeElement;
  const previous = focused instanceof HTMLElement && focused !== document.body ? focused : pressedOpener();
  const layer: Layer = { ...options, detach: () => {} };
  layer.detach = watchNativeClose(layer);
  if (stack.length === 0) {
    document.addEventListener("keydown", takeEscape);
    document.addEventListener("pointerdown", onPointerDown, true);
  }
  stack.push(layer);
  if (options.modal) lockScroll();
  options.show();

  return () => {
    const stillOpen = stack.includes(layer);
    leave(layer);
    // A modal keeps the rest of the page inert, so hide before moving focus out.
    if (stillOpen) options.hide();
    if (options.passive) return;
    const restore = () => {
      const at = document.activeElement;
      const unclaimed = !at || at === document.body || stack.some((open) => open.element === at);
      if (unclaimed || options.element.contains(at)) {
        (options.returnFocus?.() ?? previous)?.focus({ preventScroll: true });
      }
    };
    // The press's own mousedown moves focus after this, so restore behind it.
    if (dismissingByPress) setTimeout(restore);
    else restore();
  };
}

const POSITION_AREA: Record<LayerPlacement, string> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  "bottom-start": "bottom span-right",
  "bottom-end": "bottom span-left",
  "top-start": "top span-right",
  "top-end": "top span-left",
  "right-start": "right span-bottom",
  "right-end": "right span-top",
  "left-start": "left span-bottom",
  "left-end": "left span-top",
};

const GUTTER_MARGIN = { bottom: "margin-top", top: "margin-bottom", right: "margin-left", left: "margin-right" };

const WINDOW_MARGIN = 8;

const TRANSFORM_ORIGIN: Record<LayerPlacement, string> = {
  top: "bottom center",
  bottom: "top center",
  left: "center right",
  right: "center left",
  "bottom-start": "top left",
  "bottom-end": "top right",
  "top-start": "bottom left",
  "top-end": "bottom right",
  "right-start": "top left",
  "right-end": "bottom left",
  "left-start": "top right",
  "left-end": "bottom right",
};

// One name per layer: a name shared across rows resolves to the last row.
export function anchorLayer(anchor: HTMLElement, floating: HTMLElement, placement: LayerPlacement, gutter = 0) {
  const name = `--layer-anchor-${++anchorCount}`;
  const names = () =>
    anchor.style
      .getPropertyValue("anchor-name")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && part !== "none");
  anchor.style.setProperty("anchor-name", [...names(), name].join(", "));

  const side = placement.split("-")[0] as keyof typeof GUTTER_MARGIN;
  const first = side === "top" || side === "bottom" ? "flip-block" : "flip-inline";
  const second = first === "flip-block" ? "flip-inline" : "flip-block";
  const { style } = floating;
  style.setProperty("position", "fixed");
  style.setProperty("inset", "auto");
  style.setProperty("margin", "0");
  style.setProperty(GUTTER_MARGIN[side], `${gutter}px`);
  style.setProperty("position-anchor", name);
  style.setProperty("position-area", POSITION_AREA[placement]);
  style.setProperty("position-try-fallbacks", `${first}, ${second}, ${first} ${second}`);
  style.setProperty("--layer-origin", TRANSFORM_ORIGIN[placement]);
  if (!placement.includes("-")) {
    const crossInset = side === "top" || side === "bottom" ? "inset-inline" : "inset-block";
    style.setProperty(crossInset, `${WINDOW_MARGIN}px`);
  }

  return () => {
    const rest = names().filter((part) => part !== name);
    if (rest.length > 0) anchor.style.setProperty("anchor-name", rest.join(", "));
    else anchor.style.removeProperty("anchor-name");
  };
}

function longestSeconds(list: string) {
  return Math.max(0, ...list.split(",").map((part) => parseFloat(part) || 0));
}

const EXIT_GRACE_MS = 50;

export function createPresence(open: Accessor<boolean>, element: Accessor<HTMLElement | undefined>) {
  const [exited, setExited] = createSignal(false);
  const mounted = createMemo<boolean>((was) => open() || (was && !exited()), open());
  let enterAnimation = "none";

  createEffect(() => {
    const el = element();
    if (open()) {
      setExited(false);
      enterAnimation = el ? getComputedStyle(el).animationName || "none" : "none";
      return;
    }
    if (!mounted()) return;
    if (!el) {
      setExited(true);
      return;
    }

    const style = getComputedStyle(el);
    const name = style.animationName || "none";
    const seconds = longestSeconds(style.animationDuration) + longestSeconds(style.animationDelay);
    if (name === "none" || name === enterAnimation || seconds <= 0) {
      setExited(true);
      return;
    }

    const finish = (e: Event) => {
      const { pseudoElement } = e as AnimationEvent;
      if (e.target === el && !pseudoElement) setExited(true);
    };
    // A window that is not painting never fires animationend.
    const timer = setTimeout(() => setExited(true), seconds * 1000 + EXIT_GRACE_MS);
    el.addEventListener("animationend", finish);
    el.addEventListener("animationcancel", finish);
    onCleanup(() => {
      clearTimeout(timer);
      el.removeEventListener("animationend", finish);
      el.removeEventListener("animationcancel", finish);
    });
  });

  return { mounted, closed: () => mounted() && !open() };
}
