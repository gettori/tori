import { batchToMarkdown } from "../markdown";
import type { BatchRequest, Pick, ToggleRequest } from "../pick";
import { capture, insideSensitive } from "./capture";

// Injected again on every pick request; the first copy in this world answers.
const loaded = globalThis as { toriPicker?: boolean };

type Mode = "pick" | "idle";

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px system-ui, sans-serif; color-scheme: light dark; }
.outline { position: fixed; pointer-events: none; outline: 2px solid Highlight; outline-offset: 1px; border-radius: 2px; z-index: 2; }
.box, .tray, .offer { position: fixed; z-index: 3; background: Canvas; color: CanvasText; border: 1px solid GrayText; border-radius: 8px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.25); }
.box { width: 280px; padding: 8px; display: grid; gap: 6px; }
.box textarea { width: 100%; min-height: 60px; resize: vertical; padding: 6px; border: 1px solid GrayText; border-radius: 4px; background: Field; color: FieldText; }
.tray { right: 16px; bottom: 16px; width: 300px; max-height: 50vh; padding: 10px; display: grid; gap: 8px; overflow: auto; }
.tray ol { margin: 0; padding-left: 20px; display: grid; gap: 2px; }
.tray li { overflow-wrap: anywhere; }
.muted { opacity: 0.7; }
.row { display: flex; gap: 6px; justify-content: flex-end; }
button { padding: 3px 10px; border: 1px solid GrayText; border-radius: 4px; background: ButtonFace; color: ButtonText; cursor: pointer; }
.offer { padding: 4px; }
`;

const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
const DRAG_PX = 4;
const KEEP_PICKING = "Press the shortcut or click Tori to keep picking";
const PICKING = "Click an element or select text. Esc stops.";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function ask<T>(message: BatchRequest): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

function start() {
  const host = document.createElement("tori-picker");
  const root = host.attachShadow({ mode: "closed" });
  root.append(el("style", { textContent: CSS_TEXT }));
  const outline = el("div", { className: "outline" });
  const tray = el("section", { className: "tray" });
  let box: HTMLElement | null = null;
  let outlined: Element | null = null;
  let offer: HTMLElement | null = null;
  let mode: Mode | null = null;
  let picks: Pick[] = [];
  let status = "";
  let down: { x: number; y: number } | null = null;

  const ours = (e: Event) => e.composedPath().includes(host);

  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };

  const renderTray = () => {
    if (!picks.length && mode !== "pick") {
      tray.remove();
      return;
    }
    const list = el("ol");
    for (const p of picks) list.append(el("li", { textContent: p.comment || "(no comment)" }));
    const copy = el("button", { textContent: "Copy as Markdown", disabled: !picks.length });
    copy.onclick = () => {
      void navigator.clipboard.writeText(batchToMarkdown(picks)).then(
        () => setStatus("Copied"),
        () => setStatus("Could not copy"),
      );
    };
    const cancel = el("button", { textContent: "Cancel" });
    cancel.onclick = () => {
      picks = [];
      void ask({ type: "batch.clear" });
      leave();
    };
    const row = el("div", { className: "row" });
    row.append(cancel, copy);
    const note = el("p", { className: "muted", textContent: status || (mode === "pick" ? PICKING : KEEP_PICKING) });
    note.style.margin = "0";
    tray.replaceChildren(...(picks.length ? [list] : []), note, row);
    root.append(tray);
    mount();
  };

  const setStatus = (text: string) => {
    status = text;
    renderTray();
  };

  const closeBox = () => {
    box?.remove();
    box = null;
  };

  const closeOffer = () => {
    offer?.remove();
    offer = null;
  };

  const place = (node: HTMLElement, rect: DOMRect, width: number) => {
    const below = rect.bottom + 8;
    node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    node.style.top = below + 120 < innerHeight ? `${below}px` : `${Math.max(8, rect.top - 128)}px`;
  };

  const showOutline = (target: Element) => {
    outlined = target;
    const r = target.getBoundingClientRect();
    Object.assign(outline.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    root.append(outline);
    mount();
  };

  const comment = (target: Element, rect: DOMRect, selection?: { text: string; rect: DOMRect }) => {
    closeBox();
    closeOffer();
    const input = el("textarea", { placeholder: "Comment" });
    const add = el("button", { textContent: "Add" });
    const cancel = el("button", { textContent: "Cancel" });
    const row = el("div", { className: "row" });
    row.append(cancel, add);
    box = el("div", { className: "box" });
    box.append(input, row);
    place(box, rect, 280);
    root.append(box);
    const submit = () => {
      const pick = capture(target, input.value.trim(), root, selection);
      closeBox();
      void ask<Pick[]>({ type: "batch.add", pick }).then((batch) => {
        picks = batch;
        status = "";
        renderTray();
      });
    };
    add.onclick = submit;
    cancel.onclick = closeBox;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
    input.focus();
  };

  const offerSelection = (selection: Selection) => {
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const target = common instanceof Element ? common : common.parentElement;
    const text = selection.toString();
    if (!target || !text.trim() || insideSensitive(selection.anchorNode)) return false;
    const rect = range.getBoundingClientRect();
    closeOffer();
    const button = el("button", { textContent: "Pick selection" });
    offer = el("div", { className: "offer" });
    offer.append(button);
    place(offer, rect, 120);
    button.onclick = () => comment(target, rect, { text, rect });
    root.append(offer);
    return true;
  };

  const swallow = (e: Event) => {
    if (ours(e)) return;
    e.stopImmediatePropagation();
    // Left alone on the way down, so dragging still selects text.
    if (e.type === "pointerdown" || e.type === "mousedown") {
      if (e instanceof MouseEvent) down = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    if (e.type !== "click" || !(e instanceof MouseEvent)) return;
    const dragged = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX;
    const selection = getSelection();
    if (dragged && selection && !selection.isCollapsed && offerSelection(selection)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target) comment(target, target.getBoundingClientRect());
  };

  const hover = (e: MouseEvent) => {
    if (box || ours(e) || !(e.target instanceof Element)) return;
    showOutline(e.target);
  };

  const scrolled = () => {
    if (outlined) showOutline(outlined);
  };

  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (box) closeBox();
    else leave();
  };

  const listen = (on: boolean) => {
    const method = on ? addEventListener : removeEventListener;
    for (const type of SWALLOWED) method(type, swallow, true);
    method("mousemove", hover as EventListener, true);
    method("keydown", key as EventListener, true);
    method("scroll", scrolled, true);
  };

  const leave = () => {
    if (mode === "pick") listen(false);
    mode = null;
    status = "";
    closeBox();
    closeOffer();
    outline.remove();
    outlined = null;
    host.remove();
  };

  const enter = (next: Mode) => {
    if (next === "pick" && mode !== "pick") listen(true);
    if (next === "idle" && mode === "pick") return;
    mode = next;
    status = "";
    renderTray();
  };

  chrome.runtime.onMessage.addListener((message: ToggleRequest) => {
    if (message.type !== "picker.toggle") return;
    if (mode === "pick") leave();
    else enter("pick");
  });

  void ask<Pick[]>({ type: "batch.get" }).then((batch) => {
    picks = batch;
    if (mode === null && picks.length) enter("idle");
    else renderTray();
  });
}

if (!loaded.toriPicker) {
  loaded.toriPicker = true;
  start();
}
