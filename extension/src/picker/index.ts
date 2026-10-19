import type { BatchRequest, Chat, Pick, Sent, Shot, ToggleRequest } from "../pick";
import { capture, insideSensitive } from "./capture";

// Injected again on every pick request; the first copy in this world answers.
const loaded = globalThis as { toriPicker?: boolean };

type Mode = "pick" | "idle";

const CSS_TEXT = `
:host { all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; pointer-events: none; }
.box, .tray, .offer { pointer-events: auto; }
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
select { flex: 1; min-width: 0; padding: 2px 4px; border: 1px solid GrayText; border-radius: 4px; background: Field; color: FieldText; }
`;

const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
const DRAG_PX = 4;
// What isSensitive covers, blanked for the moment of a screenshot.
const MASK = `input[type="password"], input[autocomplete="off"], textarea[autocomplete="off"],
input[data-sensitive], textarea[data-sensitive] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`;
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

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const plain = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function start() {
  const host = document.createElement("tori-picker");
  host.popover = "manual";
  const root = host.attachShadow({ mode: "closed" });
  root.append(el("style", { textContent: CSS_TEXT }));
  const outline = el("div", { className: "outline" });
  const tray = el("section", { className: "tray" });
  let box: HTMLElement | null = null;
  let outlined: Element | null = null;
  let offer: HTMLElement | null = null;
  let mode: Mode | null = null;
  let picks: Pick[] = [];
  let chats: Chat[] | null = null;
  let chosen = "";
  let sent: Chat | null = null;
  let sending = false;
  let status = "";
  let down: { x: number; y: number } | null = null;

  const ours = (e: Event) => e.composedPath().includes(host);

  // In the top layer, above any z-index the page uses.
  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
    if (!host.matches(":popover-open")) host.showPopover();
  };

  const loadChats = () => {
    chats = [];
    void ask<Chat[] | null>({ type: "chats" }).then((found) => {
      chats = found ?? [];
      if (!chats.some((c) => c.id === chosen)) chosen = chats[0]?.id ?? "";
      renderTray();
    });
  };

  const sendRow = (): HTMLElement[] => {
    if (!picks.length || !chats) return [];
    if (!chats.length) return [el("p", { className: "muted", textContent: "No live chat in this worktree" })];
    const row = el("div", { className: "row" });
    if (chats.length > 1) {
      const select = el("select");
      for (const c of chats) select.append(el("option", { value: c.id, textContent: `${c.title} (${c.agent})` }));
      select.value = chosen;
      select.onchange = () => (chosen = select.value);
      row.append(select);
    }
    const only = chats.length === 1 ? ` to ${chats[0].title}` : "";
    const send = el("button", { textContent: sending ? "Sending" : `Send${only}`, disabled: sending });
    send.onclick = () => void sendTo(chats!.find((c) => c.id === chosen)!);
    row.append(send);
    return [row];
  };

  const sendTo = async (chat: Chat) => {
    sending = true;
    renderTray();
    const outcome = await ask<Sent | null>({ type: "send", chat });
    sending = false;
    if (outcome && "title" in outcome) {
      picks = [];
      sent = chat;
      status = `Sent to ${outcome.title}`;
    } else {
      status = outcome?.error ?? "Could not send";
    }
    renderTray();
  };

  const sentRow = (chat: Chat): HTMLElement => {
    const show = el("button", { textContent: "Show in Tori" });
    show.onclick = () => {
      void ask<{ error?: string } | null>({ type: "reveal", id: chat.id }).then((r) => {
        if (r?.error) setStatus(r.error);
      });
    };
    const close = el("button", { textContent: "Close" });
    close.onclick = () => leave();
    const row = el("div", { className: "row" });
    row.append(close, show);
    return row;
  };

  const renderTray = () => {
    if (!picks.length && mode !== "pick" && !sent) {
      tray.remove();
      return;
    }
    if (picks.length && chats === null) loadChats();
    const note = el("p", { className: "muted", textContent: status || (mode === "pick" ? PICKING : KEEP_PICKING) });
    note.style.margin = "0";
    if (sent && !picks.length) {
      tray.replaceChildren(note, sentRow(sent));
      root.append(tray);
      mount();
      return;
    }
    const list = el("ol");
    for (const p of picks) list.append(el("li", { textContent: p.comment || "(no comment)" }));
    const copy = el("button", { textContent: "Copy as Markdown", disabled: !picks.length });
    copy.onclick = () => {
      void ask<string>({ type: "markdown" })
        .then((text) => navigator.clipboard.writeText(text))
        .then(
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
    tray.replaceChildren(...(picks.length ? [list] : []), note, ...sendRow(), row);
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

  const screenshot = async (target: Element, range?: Range): Promise<Shot> => {
    const { scrollX, scrollY } = window;
    host.style.display = "none";
    const mask = el("style", { textContent: MASK });
    document.documentElement.append(mask);
    if (!range) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    await frame();
    await frame();
    const rect = (range ?? target).getBoundingClientRect();
    try {
      return (await ask<Shot | null>({ type: "shot", rect: plain(rect), viewport: innerWidth })) ?? { images: [] };
    } finally {
      scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      mask.remove();
      host.style.display = "";
    }
  };

  const comment = (target: Element, rect: DOMRect, selection?: { text: string; range: Range }) => {
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
    const submit = async () => {
      const facts = capture(
        target,
        input.value.trim(),
        root,
        selection && { text: selection.text, rect: selection.range.getBoundingClientRect() },
      );
      closeBox();
      const shot = await screenshot(target, selection?.range);
      picks = await ask<Pick[]>({ type: "batch.add", pick: { ...facts, images: shot.images } });
      sent = null;
      chats = null;
      status = shot.why ? `No screenshot: ${shot.why}` : "";
      renderTray();
    };
    add.onclick = () => void submit();
    cancel.onclick = closeBox;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
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
    button.onclick = () => comment(target, rect, { text, range: range.cloneRange() });
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
    chats = null;
    sent = null;
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
