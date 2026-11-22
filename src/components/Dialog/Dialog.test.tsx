import { describe, it, expect, vi, onTestFinished } from "vite-plus/test";
import { createSignal, flush } from "solid-js";
import type { JSX } from "@solidjs/web";
import { render, screen, fireEvent } from "../../test/harness";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialog.module.css";
import Dialog, { type DialogProps } from "./Dialog";

// Closing runs through effects and a press restores focus behind itself, so a
// test that asserts on the result yields first.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

// A button outside the dialog, removed even when the test fails. `cleanup`
// unmounts what `render` mounted and nothing else, so a leaked focusable in
// `document.body` would be aria-hidden by the *next* test's modal and fail its
// axe run instead of this one.
function buttonOutsideTheDialog() {
  const button = document.createElement("button");
  button.textContent = "Opener";
  document.body.append(button);
  onTestFinished(() => button.remove());
  return button;
}

function openDialog(props: Partial<Omit<DialogProps, "open" | "onClose">> = {}, children?: JSX.Element) {
  const [open, setOpen] = createSignal(true);
  const onClose = vi.fn(() => setOpen(false));
  render(() => (
    <Dialog open={open()} title="Delete branch" onClose={onClose} {...props}>
      {children}
    </Dialog>
  ));
  return { onClose, setOpen };
}

describe("Dialog", () => {
  describe("the accessible shell", () => {
    it("is a modal dialog named by its own title", () => {
      openDialog({ description: "This cannot be undone." });

      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe(screen.getByText("Delete branch").id);
      expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("This cannot be undone.").id);
    });

    it("keeps a hidden title as the accessible name", () => {
      openDialog({ titleHidden: true });

      const title = screen.getByText("Delete branch");
      expect(title.className).toBe(styles.titleHidden);
      expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe(title.id);
    });

    it("leaves the tree when closed", () => {
      const { setOpen } = openDialog();

      setOpen(false);

      flush();

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("carries a caller's class beside its own", () => {
      openDialog({ class: "pickerBody", size: "wide" });

      const dialog = screen.getByRole("dialog");
      expect(dialog.classList.contains("pickerBody")).toBe(true);
      expect(dialog.classList.contains(styles.panel)).toBe(true);
      expect(dialog.classList.contains(styles.wide)).toBe(true);
    });
  });

  describe("sizes", () => {
    // The width itself cannot be asserted here: vitest stubs the stylesheet, so
    // jsdom resolves no `var()` and every panel measures zero. What is assertable
    // is that each size reaches its own rule, which is what silently breaks when
    // a key is renamed in one file and not the other.
    it.each(["confirm", "sheet", "wide"] as const)("puts %s on its own rule", (size) => {
      openDialog({ size });

      const dialog = screen.getByRole("dialog");
      expect(dialog.classList.contains(styles[size])).toBe(true);
      expect(styles[size]).toBeTruthy();
    });

    it("defaults to confirm", () => {
      openDialog();

      expect(screen.getByRole("dialog").classList.contains(styles.confirm)).toBe(true);
    });
  });

  describe("the scrolling body", () => {
    // The one guard axe cannot be: `scrollable-region-focusable` is disabled
    // under jsdom, which has no scroll geometry, so a body that scrolls but
    // cannot be focused would pass every accessibility assertion in the suite
    // while being unscrollable by keyboard.
    it("is reachable by keyboard, since it is the scroll region", () => {
      openDialog({}, "A body with no control of its own.");

      const body = screen.getByText("A body with no control of its own.");
      expect(body.className).toBe(styles.body);
      expect(body.tabIndex).toBe(0);
    });

    it("is absent when the dialog has no body, rather than an empty tab stop", () => {
      openDialog({ description: "Nothing else to say." });

      expect(screen.getByRole("dialog").querySelector(`.${styles.body}`)).toBeNull();
    });
  });

  describe("dismissal", () => {
    it("closes on Escape", () => {
      const { onClose } = openDialog();

      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on a pointer down outside the panel", async () => {
      const { onClose } = openDialog();
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("keys", () => {
    // The seam the complex dialogs need (#100). Their Enter cannot always be
    // answered by whatever has focus: a gated confirm button is `disabled`, so
    // the browser fires no click on it, and a dialog whose `initialFocus`
    // resolves to nothing leaves focus on the panel, where no control answers
    // at all. Both places have to reach the caller, which is why this is a prop
    // on the wrapper rather than a handler a caller could put on its own body:
    // the actions row is `Dialog`'s markup, not the caller's children.
    function openWithKeys(children?: JSX.Element) {
      const onKeyDown = vi.fn();
      openDialog(
        {
          onKeyDown,
          initialFocus: () => undefined,
          actions: <button>Delete</button>,
        },
        children,
      );
      return onKeyDown;
    }

    it("reports a key pressed on the panel itself", () => {
      const onKeyDown = openWithKeys();
      expect(document.activeElement).toBe(screen.getByRole("dialog"));

      fireEvent.keyDown(document.activeElement!, { key: "Enter" });

      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(onKeyDown.mock.calls[0][0].key).toBe("Enter");
    });

    it("reports a key pressed in the actions row", () => {
      const onKeyDown = openWithKeys();

      fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), {
        key: "Enter",
      });

      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });

    it("reports a key pressed in the body", () => {
      const onKeyDown = openWithKeys(<input aria-label="Space name" />);

      fireEvent.keyDown(screen.getByLabelText("Space name"), { key: "Enter" });

      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });

    it("still closes on Escape without the caller handling it", () => {
      const onKeyDown = vi.fn();
      const { onClose } = openDialog({ onKeyDown });

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });

      // The caller sees the key, but dismissal is not its job: a caller that
      // also cancelled on Escape would answer the same dialog twice.
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus", () => {
    it("focuses the panel when no initial focus is named", () => {
      openDialog();

      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    it("focuses the element the caller names", () => {
      let input: HTMLInputElement | undefined;
      openDialog({ initialFocus: () => input }, <input ref={input} aria-label="Branch name" />);

      expect(document.activeElement).toBe(input);
    });

    // Found by the #100 stacked test: a dialog that opens already busy names its
    // confirm button, the button is `disabled`, and the browser will not focus
    // it. Focus then never entered the panel at all, so the trap held nothing
    // and a dialog stacked on top of it restored focus to nowhere on close.
    it("falls back to the panel when the element it was told to focus refuses", () => {
      let confirm: HTMLButtonElement | undefined;
      openDialog(
        {
          initialFocus: () => confirm,
          actions: (
            <button ref={confirm} disabled>
              Removing…
            </button>
          ),
        },
        "Removing the worktree.",
      );

      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    it("restores focus to whatever it interrupted", async () => {
      const opener = buttonOutsideTheDialog();
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const { setOpen } = openDialog();
      expect(document.activeElement).not.toBe(opener);

      setOpen(false);

      flush();
      await macrotask();

      expect(document.activeElement).toBe(opener);
    });

    // Every dialog #100 migrates is opened from a context-menu row, and that row
    // is gone by the time the dialog closes: the menu unmounts when it commits.
    // So the captured element is detached, `focus()` on it does nothing, and
    // focus ends up on <body> - the same place it would have landed with no
    // restore at all. Pinned rather than fixed: there is no better target to
    // name from in here (the row no longer exists), and the alternative, holding
    // a caller-supplied fallback, is a prop no caller has asked for yet. What
    // this test buys is that the day it changes, it changes visibly.
    it("leaves focus on the body when the element it captured is gone", async () => {
      const opener = buttonOutsideTheDialog();
      opener.focus();

      const { setOpen } = openDialog();
      opener.remove();

      setOpen(false);

      flush();
      await macrotask();

      expect(document.activeElement).toBe(document.body);
    });

    // The focus trap is the browser's: a native modal makes the page inert,
    // which jsdom does not model, so what is pinned is that it is a real modal.
    it("opens as a native modal", () => {
      const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
      onTestFinished(() => showModal.mockRestore());

      openDialog();

      expect(showModal).toHaveBeenCalledOnce();
      expect(screen.getByRole("dialog").tagName).toBe("DIALOG");
    });
  });

  describe("accessibility", () => {
    // Scoped to `document.body`, because the dialog is portalled and is
    // therefore a sibling of render's container rather than inside it. The three
    // cases vary the *content*, not the size: axe sees no CSS here, so three
    // sizes of the same markup would be one assertion written three times.
    it("has no violations as a prose confirmation", async () => {
      openDialog({ description: "This cannot be undone." }, "Delete `main`?");

      await expectNoAxeViolations(document.body);
    });

    it("has no violations as a form with an actions row", async () => {
      openDialog(
        {
          size: "sheet",
          description: "Names may not contain spaces.",
          actions: (
            <>
              <button>Cancel</button>
              <button>Create</button>
            </>
          ),
        },
        <label>
          Branch name
          <input />
        </label>,
      );

      await expectNoAxeViolations(document.body);
    });

    it("has no violations with a hidden title and a long body", async () => {
      openDialog(
        { size: "wide", titleHidden: true },
        <ul>
          {Array.from({ length: 40 }, (_, i) => (
            <li>Row {i}</li>
          ))}
        </ul>,
      );

      await expectNoAxeViolations(document.body);
    });
  });
});
