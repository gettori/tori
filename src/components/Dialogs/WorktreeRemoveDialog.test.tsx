import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import WorktreeRemoveDialog from "./WorktreeRemoveDialog";

// Characterization test for the worktree removal confirmation, written against
// the hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#100). See `ConfirmDialog.test.tsx` for why the file
// splits into a **contract** block that must survive the swap unchanged and a
// **shape** block that is knowingly rewritten with it.
//
// The delicate part is that this dialog is destructive and its two checkboxes
// escalate what "remove" means: local delete follows whether there is a branch
// at all, remote delete is off until asked for, and both are read at confirm
// time rather than at open time. Those defaults are the contract; a migration
// that silently flipped one would delete a branch nobody asked to lose.
//
// **Why the Enter assertions are contract and not shape.** In #99 Enter moved
// into the shape block, because `ConfirmDialog` stopped handling the key and
// leaned on the browser clicking its focused button, which jsdom does not do.
// This dialog keeps an explicit handler either side of the swap: today on the
// panel div, afterwards through `Dialog`'s `onKeyDown`. Every assertion below
// fires Enter on a *child* element, which bubbles to the handler in both
// arrangements, so it is the same assertion before and after.
//
// Escape is contract for the same reason from the other direction: today the
// panel's own handler answers it, afterwards Kobalte's dismiss layer does and
// reports it through `onClose`. Both end in exactly one `onCancel`.
//
// The dialog focuses its confirm button from a `requestAnimationFrame`, so a
// test that asserts on focus has to yield one first.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Props = Parameters<typeof WorktreeRemoveDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <WorktreeRemoveDialog
      label="feature/omnibox"
      path="/Users/x/Projects/sway/feature-omnibox"
      branch="feature/omnibox"
      dirty={false}
      unpushed={false}
      hasRemote={false}
      runningCount={0}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  return { onConfirm, onCancel };
}

const remove = () =>
  screen.getByRole("button", { name: /^Remove worktree$|^Removing…$/ }) as HTMLButtonElement;
const check = (name: string) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;
const LOCAL = "Delete local branch (git branch -D)";
const REMOTE = "Delete remote branch (git push --delete)";

describe("WorktreeRemoveDialog", () => {
  describe("contract", () => {
    it("names the worktree it is about to remove", () => {
      open();

      expect(screen.getByText("Remove worktree “feature/omnibox”?")).toBeTruthy();
    });

    it("shows what is being deleted", () => {
      open();

      expect(screen.getByText("/Users/x/Projects/sway/feature-omnibox")).toBeTruthy();
      expect(screen.getAllByText("feature/omnibox").length).toBeGreaterThan(0);
    });

    it("says the status is still unknown while it loads", () => {
      open({ dirty: null, unpushed: null });

      expect(screen.getByText("checking…")).toBeTruthy();
    });

    it("reports a clean tree once both flags are in", () => {
      open();

      expect(screen.getByText("clean")).toBeTruthy();
    });

    it("warns, in words, when the removal loses work", () => {
      open({ dirty: true, unpushed: true });

      expect(screen.getByText("uncommitted changes")).toBeTruthy();
      expect(screen.getByText("unpushed commits")).toBeTruthy();
      expect(
        screen.getByText("This deletes work that is not saved anywhere else. It cannot be undone."),
      ).toBeTruthy();
    });

    it("counts the terminal tabs the removal will stop", () => {
      open({ runningCount: 1 });

      expect(screen.getByText(/1 terminal tab \(their/)).toBeTruthy();
    });

    it("offers to delete the local branch, checked, when there is one", () => {
      open();

      expect(check(LOCAL).checked).toBe(true);
    });

    it("offers no branch checkbox at all when the worktree has no branch", () => {
      open({ branch: null });

      expect(screen.queryByRole("checkbox", { name: LOCAL })).toBeNull();
    });

    it("offers the remote branch only when one is tracked, unchecked", () => {
      open({ hasRemote: true });

      expect(check(REMOTE).checked).toBe(false);
    });

    it("hides the remote checkbox when nothing is tracked", () => {
      open();

      expect(screen.queryByRole("checkbox", { name: REMOTE })).toBeNull();
    });

    it("confirms with the checkbox state as it stands at confirm time", () => {
      const { onConfirm } = open({ hasRemote: true });

      fireEvent.click(check(REMOTE));
      fireEvent.click(remove());

      expect(onConfirm).toHaveBeenCalledWith({ deleteLocal: true, deleteRemote: true });
    });

    it("keeps the git branch when local delete is unchecked", () => {
      const { onConfirm } = open();

      fireEvent.click(check(LOCAL));
      fireEvent.click(remove());

      expect(onConfirm).toHaveBeenCalledWith({ deleteLocal: false, deleteRemote: false });
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

    it("focuses the confirm button, not the destructive checkbox", async () => {
      open();
      await frame();

      expect(document.activeElement).toBe(remove());
    });

    // Measured against the current markup, not assumed: axe reports zero
    // violations and zero incomplete here today, so this assertion is a real
    // gate from the first commit rather than something switched on after the
    // swap. The two dialogs in this set that do fail today say so in their own
    // files (`ConfirmDeleteSpace`, `DebugTargetDialog` in script mode).
    it("has no accessibility violations", async () => {
      open({ dirty: true, unpushed: true, hasRemote: true, runningCount: 2 });

      await expectNoAxeViolations(document.body);
    });
  });

  describe("shape", () => {
    // Rewritten at migration time, as the header said it would be: dismissal was
    // a `mousedown` on a real backdrop element and is now Kobalte's outside
    // `pointerdown`, from a listener it installs in a `setTimeout(0)`.
    it("cancels on a pointer down outside the panel", async () => {
      const { onCancel } = open();
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
});
