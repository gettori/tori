const openPopovers = new WeakSet<HTMLElement>();

export function isPopoverOpen(el: HTMLElement) {
  return openPopovers.has(el);
}

class ToggleEventShim extends Event {
  readonly oldState: string;
  readonly newState: string;

  constructor(type: string, init: ToggleEventInit = {}) {
    super(type, init);
    this.oldState = init.oldState ?? "";
    this.newState = init.newState ?? "";
  }
}

function requirePopover(el: HTMLElement) {
  if (!el.hasAttribute("popover")) throw new DOMException("Not a popover", "NotSupportedError");
}

function togglePopover(el: HTMLElement, oldState: string, newState: string) {
  const proceed = el.dispatchEvent(
    new ToggleEvent("beforetoggle", { oldState, newState, cancelable: newState === "open" }),
  );
  if (!proceed) return;
  // jsdom's default sheet keeps every [popover] at display none.
  if (newState === "open") {
    openPopovers.add(el);
    el.style.setProperty("display", "block");
  } else {
    openPopovers.delete(el);
    el.style.removeProperty("display");
  }
  queueMicrotask(() => el.dispatchEvent(new ToggleEvent("toggle", { oldState, newState })));
}

// Open state and events only. Focus and dismissal stay out, so a test of the
// layer module exercises that module and not a copy of the browser here.
export function installNativeLayers() {
  globalThis.ToggleEvent ??= ToggleEventShim as unknown as typeof ToggleEvent;

  // axe asks this to find an open modal. Without one it stays absent, because
  // the gate's "could not judge" case depends on jsdom not having it.
  document.elementsFromPoint ??= () => {
    if (!document.querySelector("dialog[open]")) throw new TypeError("jsdom has no layout");
    return [];
  };

  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    if (this.open) throw new DOMException("Already open", "InvalidStateError");
    this.setAttribute("open", "");
  };

  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return;
    this.removeAttribute("open");
    if (returnValue !== undefined) this.returnValue = returnValue;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  };

  HTMLElement.prototype.showPopover ??= function (this: HTMLElement) {
    requirePopover(this);
    if (openPopovers.has(this)) throw new DOMException("Already open", "InvalidStateError");
    togglePopover(this, "closed", "open");
  };

  HTMLElement.prototype.hidePopover ??= function (this: HTMLElement) {
    requirePopover(this);
    if (!openPopovers.has(this)) throw new DOMException("Already closed", "InvalidStateError");
    togglePopover(this, "open", "closed");
  };
}
