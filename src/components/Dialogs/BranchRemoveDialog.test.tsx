import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import BranchRemoveDialog from "./BranchRemoveDialog";

// Characterization test for the plain-repo branch removal, written against the
// hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#100). Same two-block split as its sibling; see
// `WorktreeRemoveDialog.test.tsx` for why Enter and Escape are contract here
// rather than shape, and `ConfirmDialog.test.tsx` for the split itself.
//
// The behavior worth pinning is that this dialog means three different things
// depending on its checkboxes, and only one of them is destructive in git:
// with local delete off it is a *detach*, the branch stays in git and only
// leaves Sway's list. That is the assertion a careless migration would lose,
// because it lives in a `Show` that renders nothing until the box is cleared.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

type Props = Parameters<typeof BranchRemoveDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <BranchRemoveDialog
      branch="feature/omnibox"
      unpushed={false}
      hasRemote={false}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  return { onConfirm, onCancel };
}

const remove = () =>
  screen.getByRole("button", { name: /^Remove branch$|^Removing…$/ }) as HTMLButtonElement;
const check = (name: string) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;
const LOCAL = "Delete local branch (git branch -D)";
const REMOTE = "Delete remote branch (git push --delete)";

describe("BranchRemoveDialog", () => {
  describe("contract", () => {
    it("names the branch it is about to remove", () => {
      open();

      expect(screen.getByText("Remove branch “feature/omnibox”?")).toBeTruthy();
    });

    it("says the status is still unknown while it loads", () => {
      open({ unpushed: null });

      expect(screen.getByText("checking…")).toBeTruthy();
    });

    it("reports a pushed branch once the flag is in", () => {
      open();

      expect(screen.getByText("pushed")).toBeTruthy();
    });

    it("warns, in words, when the branch holds commits nothing else has", () => {
      open({ unpushed: true });

      expect(screen.getByText("unpushed commits")).toBeTruthy();
      expect(
        screen.getByText("This branch has commits not on its remote. Deleting it loses them."),
      ).toBeTruthy();
    });

    it("deletes the local branch by default", () => {
      open();

      expect(check(LOCAL).checked).toBe(true);
    });

    it("offers the remote branch only when one is tracked, unchecked", () => {
      open({ hasRemote: true });

      expect(check(REMOTE).checked).toBe(false);
    });

    it("hides the remote checkbox when nothing is tracked", () => {
      open();

      expect(screen.queryByRole("checkbox", { name: REMOTE })).toBeNull();
    });

    it("says it is only a detach once local delete is cleared", () => {
      open();

      expect(
        screen.queryByText("The branch stays in git; it is only removed from Sway’s list (detach)."),
      ).toBeNull();

      fireEvent.click(check(LOCAL));

      expect(
        screen.getByText("The branch stays in git; it is only removed from Sway’s list (detach)."),
      ).toBeTruthy();
    });

    it("confirms with the checkbox state as it stands at confirm time", () => {
      const { onConfirm } = open({ hasRemote: true });

      fireEvent.click(check(REMOTE));
      fireEvent.click(remove());

      expect(onConfirm).toHaveBeenCalledWith({ deleteLocal: true, deleteRemote: true });
    });

    it("confirms on Enter", () => {
      const { onConfirm } = open();

      fireEvent.keyDown(check(LOCAL), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("does not confirm twice while the removal is already running", () => {
      const { onConfirm } = open({ busy: true });

      fireEvent.keyDown(check(LOCAL), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(remove().disabled).toBe(true);
      expect(remove().textContent).toBe("Removing…");
    });

    it("cancels on Escape", () => {
      const { onCancel } = open();

      fireEvent.keyDown(check(LOCAL), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the confirm button", async () => {
      open();
      await frame();

      expect(document.activeElement).toBe(remove());
    });

    // Measured, not assumed: zero violations and zero incomplete against the
    // current markup, so this gates from the first commit.
    it("has no accessibility violations", async () => {
      open({ unpushed: true, hasRemote: true });

      await expectNoAxeViolations(document.body);
    });
  });

  describe("shape", () => {
    // A `mousedown` on a real backdrop element. Kobalte dismisses on an outside
    // `pointerdown` from a `setTimeout(0)` listener instead, so this block is
    // knowingly rewritten at migration time.
    it("cancels on a mousedown on the backdrop", () => {
      const { onCancel } = open();

      fireEvent.mouseDown(document.querySelector(`.${styles.modalBackdrop}`)!);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("does not cancel on a mousedown inside the panel", () => {
      const { onCancel } = open();

      fireEvent.mouseDown(document.querySelector(`.${styles.modal}`)!);

      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
