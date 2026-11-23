import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "../../test/harness";
import ToastRegion, { clearToasts, pushToast } from "./Toasts";

type Agent = {
  push: (message: string) => void;
  hover: (message: string) => void;
  unhover: (message: string) => void;
};

// The implementation seam. Everything below `mount` is implementation-blind.
function mount(): Agent {
  render(() => <ToastRegion />);
  return {
    push: (message) => {
      pushToast(message, "info");
      flush();
    },
    hover: (message) => fireEvent.pointerMove(screen.getByText(message).closest('[role="status"]')!),
    unhover: (message) => fireEvent.pointerLeave(screen.getByText(message).closest('[role="status"]')!.parentElement!),
  };
}

// Text-level queries instead of DOM-shape queries, so the assertions do not
// care whether a toast is a div in a div or an li in an ol. Order of first
// appearance in textContent is DOM order.
const visible = (message: string) => document.body.textContent!.includes(message);
const position = (message: string) => document.body.textContent!.indexOf(message);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // The toast store is module-global and Region unmount clears nothing, so a
  // toast left alive here would render again in the next test's region.
  clearToasts();
  vi.useRealTimers();
});

describe("toast stack characterization", () => {
  it("stacks every toast, newest at the bottom, with no cap", () => {
    const h = mount();
    const messages = [
      "first: the worktree is locked",
      "second: renamed 12 files",
      "third: push rejected",
      "fourth: nothing is running",
    ];
    for (const m of messages) h.push(m);
    flush();
    for (const m of messages) expect(visible(m), m).toBe(true);
    for (let i = 1; i < messages.length; i++) {
      expect(position(messages[i - 1])).toBeLessThan(position(messages[i]));
    }
  });

  it("auto-dismisses a toast 8 seconds after it appears", () => {
    const h = mount();
    h.push("gone in eight");
    vi.advanceTimersByTime(7999);
    flush();
    expect(visible("gone in eight")).toBe(true);
    vi.advanceTimersByTime(1);
    flush();
    expect(visible("gone in eight")).toBe(false);
  });

  it("runs each toast's clock independently", () => {
    const h = mount();
    h.push("early");
    vi.advanceTimersByTime(3000);
    flush();
    h.push("late");
    vi.advanceTimersByTime(5000);
    flush();
    expect(visible("early")).toBe(false);
    expect(visible("late")).toBe(true);
    vi.advanceTimersByTime(3000);
    flush();
    expect(visible("late")).toBe(false);
  });

  it("keeps a hovered toast alive past its deadline, then still dismisses it", () => {
    const h = mount();
    h.push("held under the pointer");
    vi.advanceTimersByTime(4000);
    flush();
    h.hover("held under the pointer");
    vi.advanceTimersByTime(60_000);
    flush();
    expect(visible("held under the pointer")).toBe(true);
    h.unhover("held under the pointer");
    vi.advanceTimersByTime(8000);
    flush();
    expect(visible("held under the pointer")).toBe(false);
  });
});
