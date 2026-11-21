import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render } from "../test/harness";
import { anchorLayer, createPresence, openLayer } from "./layer";

const releases: Array<() => void> = [];
const nodes: HTMLElement[] = [];
const realComputedStyle = window.getComputedStyle.bind(window);

function add<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement = document.body) {
  const el = parent.appendChild(document.createElement(tag));
  nodes.push(el);
  return el;
}

function layer(element: HTMLElement, options: Partial<Parameters<typeof openLayer>[0]> = {}) {
  const onDismiss = vi.fn();
  const release = openLayer({ element, show: () => {}, hide: () => {}, onDismiss, ...options });
  releases.push(release);
  return { onDismiss, release };
}

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  for (const node of nodes.splice(0)) node.remove();
  vi.restoreAllMocks();
});

describe("the layer stack", () => {
  it("sends Escape to the topmost layer only, and consumes it", () => {
    const lower = layer(add("div"));
    const upper = layer(add("div"));
    const behind = vi.fn();
    window.addEventListener("keydown", behind);

    const notPrevented = fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", behind);

    expect(notPrevented).toBe(false);
    expect(upper.onDismiss).toHaveBeenCalledTimes(1);
    expect(lower.onDismiss).not.toHaveBeenCalled();
    expect(behind).not.toHaveBeenCalled();
  });

  it("moves Escape down once the top layer is released", () => {
    const lower = layer(add("div"));
    const upper = layer(add("div"));

    upper.release();
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(upper.onDismiss).not.toHaveBeenCalled();
    expect(lower.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone during composition and with no layer open", () => {
    const open = layer(add("div"));
    expect(fireEvent.keyDown(document.body, { key: "Escape", isComposing: true })).toBe(true);
    expect(open.onDismiss).not.toHaveBeenCalled();

    open.release();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it("leaves an Escape a control inside the layer already handled", () => {
    const panel = add("div");
    const { onDismiss } = layer(panel);
    const field = add("input", panel);
    field.addEventListener("keydown", (e) => e.preventDefault());

    fireEvent.keyDown(field, { key: "Escape" });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("sends an outside press to the topmost layer only", () => {
    const lowerEl = add("div");
    const lower = layer(lowerEl);
    const upperEl = add("div", lowerEl);
    const upper = layer(upperEl);

    fireEvent.pointerDown(add("button", upperEl));
    expect(upper.onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(lowerEl);
    expect(upper.onDismiss).toHaveBeenCalledTimes(1);
    expect(lower.onDismiss).not.toHaveBeenCalled();
  });

  it("treats a press on a dialog's backdrop as outside", () => {
    const dialog = add("dialog");
    const { onDismiss } = layer(dialog);
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 50, 50));

    fireEvent.pointerDown(dialog, { clientX: 120, clientY: 120 });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { clientX: 10, clientY: 10 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on a press the owner excludes", () => {
    const anchor = add("button");
    const { onDismiss } = layer(add("div"), { ignorePress: (target) => anchor.contains(target) });

    fireEvent.pointerDown(anchor);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("prevents the dialog's cancel and sends it to the top layer", () => {
    const dialog = add("dialog");
    const lower = layer(dialog);
    const upper = layer(add("div"));

    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(upper.onDismiss).toHaveBeenCalledTimes(1);
    expect(lower.onDismiss).not.toHaveBeenCalled();
  });

  it("ignores a cancel bubbling up from a file input", () => {
    const dialog = add("dialog");
    const { onDismiss } = layer(dialog);

    add("input", dialog).dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("brings its state in line with a native close it did not start", async () => {
    const dialog = add("dialog");
    const below = layer(add("div"));
    const owner = layer(dialog);
    const inside = layer(add("div", dialog));
    dialog.showModal();

    dialog.close();
    await Promise.resolve();

    expect(owner.onDismiss).toHaveBeenCalledTimes(1);
    expect(inside.onDismiss).toHaveBeenCalledTimes(1);
    expect(below.onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(owner.onDismiss).toHaveBeenCalledTimes(1);
    expect(below.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("brings its state in line with a popover closing natively", async () => {
    const popover = add("div");
    popover.setAttribute("popover", "manual");
    const { onDismiss } = layer(popover);
    popover.showPopover();

    popover.hidePopover();
    await Promise.resolve();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the element focused at open", () => {
    const opener = add("button");
    opener.focus();
    const panel = add("div");
    const { release } = layer(panel);
    const field = add("input", panel);
    field.focus();

    release();

    expect(document.activeElement).toBe(opener);
  });

  it("shows the layer after noting what was focused", () => {
    const opener = add("button");
    opener.focus();
    const panel = add("div");
    const field = add("input", panel);
    const { release } = layer(panel, { show: () => field.focus() });

    release();

    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the pressed button when nothing was focused", () => {
    const opener = add("button");
    const panel = add("div");
    const field = add("input", panel);
    let release = () => {};
    opener.addEventListener("click", () => {
      release = openLayer({ element: panel, show: () => field.focus(), hide: () => {}, onDismiss: () => {} });
    });

    fireEvent.click(opener);
    release();

    expect(document.activeElement).toBe(opener);
  });

  it("hides the layer before returning focus", () => {
    const order: string[] = [];
    const opener = add("button");
    const { release } = layer(add("div"), {
      hide: () => order.push("hide"),
      returnFocus: () => {
        order.push("focus");
        return opener;
      },
    });

    release();

    expect(order).toEqual(["hide", "focus"]);
  });

  it("does not hide a layer that already closed natively", async () => {
    const dialog = add("dialog");
    const hide = vi.fn();
    const { release } = layer(dialog, { hide });
    dialog.showModal();
    dialog.close();
    await Promise.resolve();

    release();

    expect(hide).not.toHaveBeenCalled();
  });

  it("returns focus to an explicit element over the one focused at open", () => {
    const opener = add("button");
    const explicit = add("button");
    opener.focus();
    const panel = add("div");
    const { release } = layer(panel, { returnFocus: () => explicit });
    add("input", panel).focus();

    release();

    expect(document.activeElement).toBe(explicit);
  });

  it("leaves focus alone when it already moved elsewhere", () => {
    const opener = add("button");
    const elsewhere = add("button");
    opener.focus();
    const { release } = layer(add("div"));
    elsewhere.focus();

    release();

    expect(document.activeElement).toBe(elsewhere);
  });

  it("returns focus after the press that dismissed the layer", async () => {
    const opener = add("button");
    opener.focus();
    const panel = add("div");
    const release: () => void = openLayer({
      element: panel,
      show: () => {},
      hide: () => {},
      onDismiss: () => release(),
    });
    add("input", panel).focus();

    fireEvent.pointerDown(document.body);
    (document.activeElement as HTMLElement).blur();
    await new Promise((resolve) => setTimeout(resolve));

    expect(document.activeElement).toBe(opener);
  });

  it("keeps focus on what the dismissing press focused", async () => {
    const opener = add("button");
    const pressed = add("input");
    opener.focus();
    const panel = add("div");
    const release: () => void = openLayer({
      element: panel,
      show: () => {},
      hide: () => {},
      onDismiss: () => release(),
    });
    add("input", panel).focus();

    fireEvent.pointerDown(pressed);
    pressed.focus();
    await new Promise((resolve) => setTimeout(resolve));

    expect(document.activeElement).toBe(pressed);
  });

  it("treats focus left on a lower layer's own element as unclaimed", () => {
    const opener = add("button");
    const lowerEl = add("dialog");
    lowerEl.tabIndex = -1;
    layer(lowerEl);
    opener.focus();
    const upper = add("div");
    const { release } = layer(upper);
    lowerEl.focus();

    release();

    expect(document.activeElement).toBe(opener);
  });

  it("locks scroll until the last modal layer is released", () => {
    const root = document.documentElement;
    root.style.overflow = "auto";
    const first = layer(add("div"), { modal: true });
    const second = layer(add("div"), { modal: true });
    expect(root.style.overflow).toBe("hidden");

    second.release();
    expect(root.style.overflow).toBe("hidden");

    first.release();
    expect(root.style.overflow).toBe("auto");
    root.style.overflow = "";
  });

  it("does not lock scroll for a non modal layer", () => {
    layer(add("div"));
    expect(document.documentElement.style.overflow).toBe("");
  });
});

describe("anchorLayer", () => {
  it("gives each layer its own anchor name and places it with CSS", () => {
    const anchor = add("button");
    const first = add("div");
    const second = add("div");

    const releaseFirst = anchorLayer(anchor, first, "bottom-start", 12);
    const releaseSecond = anchorLayer(anchor, second, "right-end");
    const firstName = first.style.getPropertyValue("position-anchor");
    const secondName = second.style.getPropertyValue("position-anchor");

    expect(firstName).not.toBe(secondName);
    expect(anchor.style.getPropertyValue("anchor-name")).toBe(`${firstName}, ${secondName}`);
    expect(first.style.getPropertyValue("position-area")).toBe("bottom span-right");
    expect(first.style.getPropertyValue("position-try-fallbacks")).toBe(
      "flip-block, flip-inline, flip-block flip-inline",
    );
    expect(first.style.getPropertyValue("margin-top")).toBe("12px");
    expect(second.style.getPropertyValue("position-try-fallbacks")).toBe(
      "flip-inline, flip-block, flip-inline flip-block",
    );

    releaseFirst();
    expect(anchor.style.getPropertyValue("anchor-name")).toBe(secondName);
    releaseSecond();
    expect(anchor.style.getPropertyValue("anchor-name")).toBe("");
  });
});

describe("createPresence", () => {
  function animation(animationName: string, animationDuration = "0.1s") {
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = realComputedStyle(el, pseudo);
      return new Proxy(style, {
        get(target, key) {
          if (key === "animationName") return animationName;
          if (key === "animationDuration") return animationDuration;
          if (key === "animationDelay") return "0s";
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
  }

  function mount() {
    const [open, setOpen] = createSignal(true);
    const [el, setEl] = createSignal<HTMLElement>();
    let presence!: ReturnType<typeof createPresence>;
    const { queryByText } = render(() => {
      presence = createPresence(open, el);
      return (
        <Show when={presence.mounted()}>
          <div ref={setEl} data-closed={presence.closed() ? "" : undefined}>
            panel
          </div>
        </Show>
      );
    });
    return { setOpen, panel: () => queryByText("panel") };
  }

  it("unmounts at once with no animation", () => {
    animation("none");
    const { setOpen, panel } = mount();

    setOpen(false);

    expect(panel()).toBeNull();
  });

  it("unmounts at once when enter and exit share an animation name", () => {
    animation("fade");
    const { setOpen, panel } = mount();

    setOpen(false);

    expect(panel()).toBeNull();
  });

  it("holds the node with data-closed until its animation ends", () => {
    animation("in");
    const { setOpen, panel } = mount();
    expect(panel()!.hasAttribute("data-closed")).toBe(false);
    animation("out");

    setOpen(false);
    const held = panel()!;
    expect(held.hasAttribute("data-closed")).toBe(true);

    const child = held.appendChild(document.createElement("span"));
    child.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(panel()).not.toBeNull();

    held.dispatchEvent(new Event("animationend"));
    expect(panel()).toBeNull();
  });

  it("gives up waiting when no animationend arrives", () => {
    vi.useFakeTimers();
    animation("in");
    const { setOpen, panel } = mount();
    animation("out");

    setOpen(false);
    expect(panel()).not.toBeNull();

    vi.advanceTimersByTime(200);
    expect(panel()).toBeNull();
    vi.useRealTimers();
  });

  it("keeps the node when reopened during the exit", () => {
    animation("in");
    const { setOpen, panel } = mount();
    animation("out");
    setOpen(false);
    const held = panel()!;

    setOpen(true);
    held.dispatchEvent(new Event("animationend"));

    expect(panel()).toBe(held);
    expect(held.hasAttribute("data-closed")).toBe(false);
  });
});
