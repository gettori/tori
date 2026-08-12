import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import PromptModal from "./PromptModal";

// Characterization test for the `window.prompt` replacement, written against
// the hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#99). See `ConfirmDialog.test.tsx` for why the file is
// split into a **contract** block that must survive the swap unchanged and a
// **shape** block that is knowingly rewritten with it.
//
// The contract that matters most here is the one the callers inherited from
// `prompt()`: submitting the empty string is a real answer (blank = the git
// default branch), and only a cancel is an absence. A migration that started
// treating "" as a cancel would silently change what those callers do.
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type PromptProps = Parameters<typeof PromptModal>[0];

function open(props: Partial<Omit<PromptProps, "onSubmit" | "onCancel">> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <PromptModal
      title="Rename branch"
      initial="feature-x"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />
  ));
  const input = document.querySelector<HTMLInputElement>(`.${styles.input}`)!;
  return { onSubmit, onCancel, input };
}

describe("PromptModal", () => {
  describe("contract", () => {
    it("asks its question", () => {
      open();

      expect(screen.getByText("Rename branch")).toBeTruthy();
    });

    it("seeds the input with the suggested value", () => {
      const { input } = open();

      expect(input.value).toBe("feature-x");
    });

    it("focuses and selects the seed, so a suggestion is one keystroke from gone", async () => {
      const { input } = open();
      await frame();

      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe("feature-x".length);
    });

    it("submits the typed value on Enter", () => {
      const { onSubmit, input } = open();

      fireEvent.input(input, { target: { value: "feature-y" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("feature-y");
    });

    it("submits the empty string as a real answer, not as a cancel", () => {
      const { onSubmit, onCancel, input } = open();

      fireEvent.input(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("");
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("submits the current value when OK is clicked", () => {
      const { onSubmit, input } = open();

      fireEvent.input(input, { target: { value: "feature-z" } });
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(onSubmit).toHaveBeenCalledWith("feature-z");
    });

    it("cancels on Escape without submitting", () => {
      const { onSubmit, onCancel, input } = open();

      fireEvent.keyDown(input, { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("cancels when Cancel is clicked", () => {
      const { onSubmit, onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows the value being replaced when the caller passes one", () => {
      open({ note: "Currently feature-x" });

      expect(screen.getByText("Currently feature-x")).toBeTruthy();
    });

    it("names the submit button after the action it performs", () => {
      open({ okLabel: "Rename" });

      expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
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
      open({ note: "Currently feature-x" });

      await expectNoAxeViolations(document.body);
    });
  });
});
