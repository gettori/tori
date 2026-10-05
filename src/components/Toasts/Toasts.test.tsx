// The pattern to copy for a *portalled* component.
//
// `ToastRegion` renders inside a `<Portal>`, which mounts to `document.body`.
// That makes it a sibling of the `container` returned by `render`, not a
// descendant, so the scope rule is:
//
//   * inline component  -> `expectNoAxeViolations(container)`
//   * portalled component -> `expectNoAxeViolations(document.body)`
//
// Getting this wrong does not fail loudly: a container-scoped run on a portalled
// component audits an empty div and passes. `src/test/domSetup.ts` unmounts after
// each test, so a body-scoped run only ever sees the current test's DOM.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ToastRegion, { pushToast } from "./Toasts";
import { Toast } from "../../lib/toast";
import { emit, FOCUS_TOASTS } from "../../utils/events";
import { expectNoAxeViolations } from "../../test/axe";

// The toast store is module-global; Region unmount clears nothing, so without
// this a toast pushed here would render again in the next test's region.
afterEach(() => Toast.toaster.clear());

function mountTwo() {
  const result = render(() => <ToastRegion />);
  pushToast("Could not remove the worktree", "error");
  pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} });
  return result;
}

describe("ToastRegion accessibility", () => {
  it("has no violations in the portalled stack", async () => {
    mountTwo();

    // `document.body`, not `container`: the stack is portalled.
    await expectNoAxeViolations(document.body);
  });

  // Guards the scope rule itself. If this ever starts finding the toasts, the
  // portal has stopped being a portal and the comment above is wrong.
  it("is not reachable from the render container, which is why the scope differs", () => {
    const { container } = mountTwo();

    expect(container.textContent).toBe("");
    expect(document.body.textContent).toContain("Could not remove the worktree");
  });

  it("exposes a labelled region and one status per toast, named by its message", () => {
    mountTwo();

    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Could not remove the worktree" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Renamed 12 files" })).toBeTruthy();
  });

  it("focuses the list on FOCUS_TOASTS, the registry's Cmd+Option+T", () => {
    render(() => <ToastRegion />);
    pushToast("push rejected", "error");

    emit(FOCUS_TOASTS);

    expect(document.activeElement).toBe(
      screen.getByRole("status", { name: "push rejected" }).parentElement,
    );
  });

  // Kobalte matches its built-in hotkey with `hotkey.every(...)`, and `every`
  // on an empty array is true: emptying that prop would focus the stack on
  // every keystroke in the app. The sentinel string in ToastRegion is what
  // keeps the listener dead, and this is what says so out loud.
  it("does not grab focus on an unrelated keystroke", () => {
    render(() => <ToastRegion />);
    pushToast("branch attached", "info");
    const before = document.activeElement;

    fireEvent.keyDown(document, { key: "t", code: "KeyT", altKey: true });
    fireEvent.keyDown(document, { key: "a", code: "KeyA" });

    expect(document.activeElement).toBe(before);
  });

  it("dismisses the focused toast on Escape", () => {
    render(() => <ToastRegion />);
    pushToast("push rejected", "error");

    const toast = screen.getByRole("status", { name: "push rejected" });
    toast.focus();
    fireEvent.keyDown(toast, { key: "Escape" });

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("pushToast", () => {
  it("drops empty and whitespace-only messages, the old clear-the-banner idiom", () => {
    render(() => <ToastRegion />);
    pushToast("");
    pushToast("   ");

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("runs the action and then dismisses, in that order", () => {
    render(() => <ToastRegion />);
    const ran = vi.fn(() => {
      // Still mounted at the moment the action runs: run-then-dismiss.
      expect(screen.getByRole("status")).toBeTruthy();
    });
    pushToast("Renamed 12 files", "info", { label: "Undo", run: ran });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(ran).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
