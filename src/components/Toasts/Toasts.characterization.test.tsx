// Characterization of the toast stack's observable behavior, written against
// the hand-rolled implementation before the Kobalte migration (#105) and kept
// green, assertions unmodified, across it.
//
// The agent below is the only part that knows which implementation is
// mounted; everything the tests assert goes through it or through
// `document.body.textContent`. Deliberately not characterized, because the two
// implementations disagree by design (see grimoire/plan.md, Decisions): what
// hovering does to a *sibling* toast's timer, and whether mouse-leave re-arms
// the full TTL or resumes the remaining time. The assertions here are the
// intersection both implementations honor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ToastRegion, { pushToast } from "./Toasts";
import { Toast } from "../../lib/toast";

type Agent = {
  push: (message: string) => void;
  hover: (message: string) => void;
  unhover: (message: string) => void;
};

// The implementation seam. Everything below `mount` is implementation-blind.
function mount(): Agent {
  render(() => <ToastRegion />);
  return {
    push: (message) => pushToast(message, "info"),
    // Kobalte pauses on pointermove anywhere in the list and resumes when the
    // pointer leaves the list, so the events target the toast and the list.
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
  Toast.toaster.clear();
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
    for (const m of messages) expect(visible(m), m).toBe(true);
    for (let i = 1; i < messages.length; i++) {
      expect(position(messages[i - 1])).toBeLessThan(position(messages[i]));
    }
  });

  it("auto-dismisses a toast 8 seconds after it appears", () => {
    const h = mount();
    h.push("gone in eight");
    vi.advanceTimersByTime(7999);
    expect(visible("gone in eight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible("gone in eight")).toBe(false);
  });

  it("runs each toast's clock independently", () => {
    const h = mount();
    h.push("early");
    vi.advanceTimersByTime(3000);
    h.push("late");
    vi.advanceTimersByTime(5000);
    expect(visible("early")).toBe(false);
    expect(visible("late")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(visible("late")).toBe(false);
  });

  it("keeps a hovered toast alive past its deadline, then still dismisses it", () => {
    const h = mount();
    h.push("held under the pointer");
    vi.advanceTimersByTime(4000);
    h.hover("held under the pointer");
    vi.advanceTimersByTime(60_000);
    expect(visible("held under the pointer")).toBe(true);
    h.unhover("held under the pointer");
    // One full TTL covers both implementations: the old one re-arms the full
    // 8s on leave, the new one resumes the 4s that remained.
    vi.advanceTimersByTime(8000);
    expect(visible("held under the pointer")).toBe(false);
  });
});
