import { describe, expect, it } from "vite-plus/test";
import { isPopoverOpen } from "./nativeLayers";

const tick = () => Promise.resolve();

describe("the native layer shim", () => {
  it("opens and closes a dialog, with close after the state change", async () => {
    const dialog = document.body.appendChild(document.createElement("dialog"));
    const seen: boolean[] = [];
    dialog.addEventListener("close", () => seen.push(dialog.open));

    dialog.showModal();
    expect(dialog.open).toBe(true);
    expect(() => dialog.showModal()).toThrow();

    dialog.close();
    expect(dialog.open).toBe(false);
    expect(seen).toEqual([]);

    await tick();
    expect(seen).toEqual([false]);
    dialog.remove();
  });

  it("orders beforetoggle, the state change and toggle", async () => {
    const popover = document.body.appendChild(document.createElement("div"));
    popover.setAttribute("popover", "manual");
    const seen: string[] = [];
    for (const type of ["beforetoggle", "toggle"]) {
      popover.addEventListener(type, (e) => {
        const { oldState, newState } = e as ToggleEvent;
        seen.push(`${type} ${oldState}>${newState} open=${isPopoverOpen(popover)}`);
      });
    }

    popover.showPopover();
    await tick();
    popover.hidePopover();
    await tick();

    expect(seen).toEqual([
      "beforetoggle closed>open open=false",
      "toggle closed>open open=true",
      "beforetoggle open>closed open=true",
      "toggle open>closed open=false",
    ]);
    popover.remove();
  });

  it("refuses an element with no popover attribute and a repeat show", () => {
    const plain = document.createElement("div");
    expect(() => plain.showPopover()).toThrow();

    const popover = document.createElement("div");
    popover.setAttribute("popover", "manual");
    popover.showPopover();
    expect(() => popover.showPopover()).toThrow();
    popover.hidePopover();
    expect(() => popover.hidePopover()).toThrow();
  });
});
