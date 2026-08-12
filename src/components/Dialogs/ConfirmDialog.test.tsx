import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import buttonStyles from "../Button/Button.module.css";
import styles from "./Dialogs.module.css";
import ConfirmDialog from "./ConfirmDialog";

// Characterization test, written against the hand-rolled implementation and
// kept green across the migration onto `components/Dialog` (#99). Nothing here
// asserted a behavior that was newly designed; it pins what callers of
// `askConfirm` already rely on, so that an unchanged file is itself the proof
// that the shell swap changed nothing.
//
// Two blocks, and the split is load-bearing:
//
//   * **contract** - what a caller relies on. Every assertion is written to
//     hold for the hand-rolled portal *and* for the Kobalte shell, so this
//     block must survive the migration byte for byte.
//   * **shape** - assertions coupled to how dismissal is wired today, a
//     `mousedown` on a real backdrop element. Kobalte dismisses on a
//     `pointerdown` anywhere outside the panel, from a listener installed in a
//     `setTimeout(0)`, so no single `fireEvent` satisfies both and this block
//     is knowingly rewritten at migration time.
//
// The dialog focuses its confirm button from a `requestAnimationFrame`, so a
// test that asserts on focus, or that fires a key the focused element must
// receive, has to wait a frame first.
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type ConfirmProps = Parameters<typeof ConfirmDialog>[0];

function open(props: Partial<Omit<ConfirmProps, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <ConfirmDialog
      title="Delete branch"
      message="This cannot be undone."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  return { onConfirm, onCancel };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("ConfirmDialog", () => {
  describe("contract", () => {
    it("asks its question and explains it", () => {
      open();

      expect(screen.getByText("Delete branch")).toBeTruthy();
      expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    });

    it("omits the explanation when there is none", () => {
      // Rendered directly rather than through `open`: a spread cannot un-set a
      // prop the helper already named.
      render(() => (
        <ConfirmDialog title="Delete branch" onConfirm={vi.fn()} onCancel={vi.fn()} />
      ));

      expect(screen.getByText("Delete branch")).toBeTruthy();
      expect(document.querySelector(`.${styles.msg}`)).toBeNull();
    });

    it("focuses the confirm button, so the default action is one keystroke away", async () => {
      open();
      await frame();

      expect(document.activeElement).toBe(button("OK"));
    });

    it("resolves false on Escape", async () => {
      const { onConfirm, onCancel } = open();
      await frame();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("resolves true when the confirm button is clicked", () => {
      const { onConfirm } = open();

      fireEvent.click(button("OK"));

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("resolves false when Cancel is clicked", () => {
      const { onCancel } = open();

      fireEvent.click(button("Cancel"));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("names the confirm button after the action it performs", () => {
      open({ confirmLabel: "Delete" });

      expect(button("Delete")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
    });

    it("marks a destructive confirm as destructive", () => {
      open({ confirmLabel: "Delete", danger: true });

      expect(button("Delete").classList.contains(buttonStyles.danger)).toBe(true);
      expect(button("Delete").classList.contains(buttonStyles.primary)).toBe(false);
    });

    it("leaves a non-destructive confirm as the primary action", () => {
      open();

      expect(button("OK").classList.contains(buttonStyles.primary)).toBe(true);
    });
  });

  describe("shape", () => {
    it("resolves true on Enter, because the focused confirm button answers for it", async () => {
      const { onConfirm } = open();
      await frame();

      // The dialog no longer handles Enter at all. It focuses the confirm
      // button, and a browser fires a click on a focused button when Enter is
      // pressed. jsdom does not synthesize that click, so the assertion is
      // split: the focus is the half this component owns, the click is the half
      // the browser owns.
      expect(document.activeElement).toBe(button("OK"));
      fireEvent.click(document.activeElement!);

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("resolves false on a pointer down outside the panel", async () => {
      const { onCancel } = open();
      // Kobalte installs its outside-pointerdown listener from a
      // `setTimeout(0)`, so a press fired before this yield lands on nobody.
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("stays open on a pointer down inside the panel", async () => {
      const { onCancel } = open();
      await macrotask();

      fireEvent.pointerDown(screen.getByRole("dialog"));

      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  // Scoped to `document.body`, not to the panel: the dialog is portalled out of
  // the render container, and modality is expressed by aria-hiding its
  // siblings, which is only visible from the root.
  describe("accessibility", () => {
    it("has no violations", async () => {
      open();

      await expectNoAxeViolations(document.body);
    });

    it("has no violations as a destructive confirm", async () => {
      open({ confirmLabel: "Delete", danger: true });

      await expectNoAxeViolations(document.body);
    });
  });
});
