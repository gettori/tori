import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import InitGitDialog from "./InitGitDialog";

// Characterization test for the "turn this folder into a repo" dialog, written
// against the hand-rolled implementation and kept green across the migration
// onto `components/Dialog` (#99). See `ConfirmDialog.test.tsx` for why the file
// splits into a **contract** block that must survive the swap unchanged and a
// **shape** block that is knowingly rewritten with it.
//
// The payload is the contract: this dialog replaced two separate menu items, so
// `bare` decides between a plain `git init` and an in-place `.bare` + worktree
// container, and the two are not interchangeable after the fact. Blank fields
// are meaningful too, an empty branch means "let git pick" rather than "".
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type InitProps = Parameters<typeof InitGitDialog>[0];

function open(props: Partial<Omit<InitProps, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <InitGitDialog
      folderName="notes"
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  return {
    onConfirm,
    onCancel,
    branch: screen.getByPlaceholderText("main") as HTMLInputElement,
    url: screen.getByPlaceholderText("git@github.com:org/repo.git") as HTMLInputElement,
    bare: screen.getByRole("button", { name: "Bare + worktree" }),
  };
}

describe("InitGitDialog", () => {
  describe("contract", () => {
    it("names the folder it is about to change", () => {
      open();

      expect(screen.getByText("Initialize git in “notes”")).toBeTruthy();
    });

    it("focuses the branch field", async () => {
      const { branch } = open();
      await frame();

      expect(document.activeElement).toBe(branch);
    });

    it("defaults to a plain repo with no branch or remote named", () => {
      const { onConfirm } = open();

      fireEvent.click(screen.getByRole("button", { name: "Initialize" }));

      expect(onConfirm).toHaveBeenCalledWith({ branch: "", url: "", bare: false });
    });

    it("trims what was typed", () => {
      const { onConfirm, branch, url } = open();

      fireEvent.input(branch, { target: { value: "  trunk  " } });
      fireEvent.input(url, { target: { value: " https://example.com/x.git " } });
      fireEvent.click(screen.getByRole("button", { name: "Initialize" }));

      expect(onConfirm).toHaveBeenCalledWith({
        branch: "trunk",
        url: "https://example.com/x.git",
        bare: false,
      });
    });

    it("carries the bare + worktree choice", () => {
      const { onConfirm, bare } = open();

      fireEvent.click(bare);
      fireEvent.click(screen.getByRole("button", { name: "Initialize" }));

      expect(onConfirm).toHaveBeenCalledWith({ branch: "", url: "", bare: true });
    });

    it("says which of the two layouts is about to be created", () => {
      const { bare } = open();

      expect(
        screen.getByText("A standard git repository with one working tree in this folder."),
      ).toBeTruthy();

      fireEvent.click(bare);

      expect(
        screen.getByText(
          "A .bare repo in this folder, with each branch checked out as its own sibling folder.",
        ),
      ).toBeTruthy();
    });

    it("confirms on Enter from inside the dialog", () => {
      const { onConfirm, branch } = open();

      fireEvent.input(branch, { target: { value: "trunk" } });
      fireEvent.keyDown(branch, { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledWith({ branch: "trunk", url: "", bare: false });
    });

    it("ignores Enter while the init is already running", () => {
      const { onConfirm, branch } = open({ busy: true });

      fireEvent.keyDown(branch, { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("says it is working and blocks a second submit", () => {
      const { onConfirm } = open({ busy: true });

      const submit = screen.getByRole("button", { name: "Initializing…" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      fireEvent.click(submit);

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels on Escape", () => {
      const { onCancel, onConfirm, branch } = open();

      fireEvent.keyDown(branch, { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels when Cancel is clicked", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("shape", () => {
    it("cancels on a pointer down outside the panel", async () => {
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

  // Scoped to `document.body`: the panel is portalled out of the render
  // container, and modality is expressed by aria-hiding its siblings.
  describe("accessibility", () => {
    it("has no violations", async () => {
      open();

      await expectNoAxeViolations(document.body);
    });
  });
});
