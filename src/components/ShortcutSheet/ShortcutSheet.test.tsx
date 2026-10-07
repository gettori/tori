import { describe, it, expect, vi, onTestFinished } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { bindingsByGroup, GROUP_LABELS } from "../../utils/hotkeys";
import styles from "./ShortcutSheet.module.css";
import ShortcutSheet from "./ShortcutSheet";
import { keyLabel } from "../../utils/platform";

// Characterization test for the Cmd+/ sheet, written against the hand-rolled
// implementation and kept green across the migration onto `components/Dialog`
// (#99). See `ConfirmDialog.test.tsx` for why the file splits into a
// **contract** block that must survive the swap unchanged and a **shape** block
// that is knowingly rewritten with it.
//
// This is the one of the seven whose accessibility was already hand-built, and
// the migration deletes both halves of it: a capture-phase `window` keydown
// (there because a focused xterm swallows the event before it reaches window)
// and a manual focus save/restore. So the assertions here are exactly the ones
// that say whether Kobalte's focus trap really replaces them, rather than the
// sheet merely still rendering.
//
// Kobalte's focus scope dispatches its unmount auto-focus from a
// `setTimeout(0)`, so the restore assertion has to yield a macrotask. The
// current implementation restores synchronously in `onCleanup`, and a yield is
// harmless there, which is what lets one assertion cover both.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A focusable outside the sheet, removed even when the test fails. */
function opener() {
  const button = document.createElement("button");
  button.textContent = "Opener";
  document.body.append(button);
  button.focus();
  onTestFinished(() => button.remove());
  return button;
}

function open() {
  const onClose = vi.fn();
  const { unmount } = render(() => <ShortcutSheet onClose={onClose} />);
  return { onClose, unmount };
}

describe("ShortcutSheet", () => {
  describe("contract", () => {
    it("is a dialog named for what it lists", () => {
      open();

      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    });

    it("keeps its own width rather than the `wide` panel's", () => {
      open();

      // The rule itself lives outside `@layer components`, since
      // `Dialog.module.css` is unlayered and would otherwise win at any
      // specificity. All this can check under jsdom is that the class reaches
      // the panel at all; the width is confirmed in the running app.
      expect(screen.getByRole("dialog").classList.contains(styles.sheetWidth)).toBe(true);
    });

    it("says how to get out of it", () => {
      open();

      expect(screen.getByText("Esc to close")).toBeTruthy();
    });

    it("renders every binding the canonical table carries", () => {
      open();

      const groups = bindingsByGroup();
      expect(groups.length).toBeGreaterThan(0);

      for (const group of groups) {
        for (const binding of group.bindings) {
          expect(screen.getAllByText(binding.label).length).toBeGreaterThan(0);
          for (const key of binding.keys) {
            expect(screen.getAllByText(keyLabel(key)).length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("groups them in table order, and lists no group that has no bindings", () => {
      open();

      // Read off the headings rather than searching for each label as free
      // text: a group label ("View", "Search") can also be a binding's own
      // label, which would make a text query prove the wrong thing in both
      // directions.
      const headings = [...document.querySelectorAll(`.${styles.groupTitle}`)].map((h) => h.textContent);

      expect(headings).toEqual(bindingsByGroup().map((g) => GROUP_LABELS[g.group]));
    });

    it("takes focus on open, so a screen reader is actually inside it", () => {
      opener();
      open();

      expect(screen.getByRole("dialog")).toBe(document.activeElement);
    });

    it("closes on Escape", () => {
      const { onClose } = open();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("gives focus back to whatever it interrupted", async () => {
      const button = opener();
      const { unmount } = open();

      expect(document.activeElement).not.toBe(button);

      unmount();
      await macrotask();

      expect(document.activeElement).toBe(button);
    });
  });

  describe("shape", () => {
    it("closes on a pointer down outside the sheet", async () => {
      const { onClose } = open();
      // Kobalte installs its outside-pointerdown listener from a
      // `setTimeout(0)`, so a press fired before this yield lands on nobody.
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("stays open on a pointer down inside the sheet", async () => {
      const { onClose } = open();
      await macrotask();

      fireEvent.pointerDown(screen.getByRole("dialog"));

      expect(onClose).not.toHaveBeenCalled();
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
