import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import PickerModal from "./PickerModal";

// Characterization test for the fuzzy single-select picker behind `askPick`,
// written against the hand-rolled implementation and kept green across the
// migration onto `components/Dialog` (#100). Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// This is the one dialog in the set whose *body* also changes in #100: phase 3
// turns its rows into a real `listbox`/`option` list driven by
// `aria-activedescendant`. That splits the assertions here differently from the
// other six, and the split is deliberate:
//
//   * **contract** - which item a keystroke commits. `ArrowDown` then `Enter`
//     selects the second match whether the highlight is expressed by a class or
//     by `aria-activedescendant`, so these survive both changes.
//   * **shape** - *how* the highlight is expressed, i.e. reading
//     `styles.active` off a row. There is no role-based way to ask that
//     question today (the rows are `div`s with no roles at all), which is the
//     accessibility gap phase 3 closes, so the question has to be asked through
//     the class until it can be asked through the accessibility tree.
//
// Enter is contract for the reason given in `WorktreeRemoveDialog.test.tsx`:
// the handler is explicit either side of the swap, and every assertion fires
// the key on the input, which is where it is handled now and after.
//
// The input is focused from a `requestAnimationFrame`, so focus assertions
// yield a frame first.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

type Props = Parameters<typeof PickerModal>[0];

function open(props: Partial<Omit<Props, "onSubmit" | "onCancel">> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <PickerModal
      title="Attach a branch"
      items={["main", "develop", "feature/omnibox"]}
      placeholder="Filter branches"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />
  ));
  const input = () => screen.getByPlaceholderText("Filter branches") as HTMLInputElement;
  const rows = () =>
    Array.from(document.querySelectorAll<HTMLElement>(`.${styles.pickerItem}`));
  const active = () => rows().find((r) => r.classList.contains(styles.active));
  return { onSubmit, onCancel, input, rows, active };
}

const type = (el: HTMLInputElement, value: string) =>
  fireEvent.input(el, { target: { value } });

describe("PickerModal", () => {
  describe("contract", () => {
    it("names what is being picked", () => {
      open();

      expect(screen.getByText("Attach a branch")).toBeTruthy();
    });

    it("offers every item before anything is typed", () => {
      const { rows } = open();

      expect(rows().map((r) => r.textContent)).toEqual([
        "main",
        "develop",
        "feature/omnibox",
      ]);
    });

    it("narrows the list as the filter is typed", () => {
      const { input, rows } = open();

      type(input(), "omni");

      expect(rows().map((r) => r.textContent)).toEqual(["feature/omnibox"]);
    });

    it("says so when nothing matches", () => {
      const { input, rows } = open();

      type(input(), "zzzz");

      expect(rows()).toHaveLength(0);
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("commits the highlighted item on Enter", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("main");
    });

    it("moves the highlight down and commits what it lands on", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("wraps from the last item back to the first", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "ArrowUp" });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("feature/omnibox");
    });

    it("commits the filtered highlight, not the item that was first before typing", () => {
      const { onSubmit, input } = open();

      type(input(), "e");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0]).not.toBe("main");
    });

    it("commits the row that is clicked", () => {
      const { onSubmit, rows } = open();

      fireEvent.click(rows()[1]);

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("commits an exactly typed item on Ok", () => {
      const { onSubmit, input } = open();

      type(input(), "develop");
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("refuses to invent an item when it is not creatable", () => {
      const { onSubmit, input } = open();

      type(input(), "brand-new");
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("creates the typed name on Ok when it is creatable", () => {
      const { onSubmit, input } = open({ creatable: true, okLabel: "Create" });

      type(input(), "brand-new");
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      expect(onSubmit).toHaveBeenCalledWith("brand-new");
    });

    it("still accepts the highlight on Enter while rows match, creatable or not", () => {
      const { onSubmit, input } = open({ creatable: true });

      type(input(), "main");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("main");
    });

    it("clears the filter and hands focus back to it", () => {
      const { input, rows } = open();

      type(input(), "omni");
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      expect(input().value).toBe("");
      expect(rows()).toHaveLength(3);
      expect(document.activeElement).toBe(input());
    });

    it("offers no clear button until there is something to clear", () => {
      const { input } = open();

      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

      type(input(), "o");

      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    });

    it("cancels on Escape", () => {
      const { onCancel, input } = open();

      fireEvent.keyDown(input(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the filter", async () => {
      const { input } = open();
      await frame();

      expect(document.activeElement).toBe(input());
    });

    // Measured against the current markup: zero violations, zero incomplete.
    // Worth reading with the phase-3 work in mind, because it is exactly what
    // this gate does *not* say: the rows are unroled `div`s, so there is no
    // list here for axe to find fault with, and a keyboard-only user has no
    // announced selection at all. Clean is not the same as complete.
    it("has no accessibility violations", async () => {
      open();

      await expectNoAxeViolations(document.body);
    });
  });

  describe("shape", () => {
    // How the highlight is expressed. Phase 3 replaces the class with
    // `aria-activedescendant` on a real listbox, and rewrites these to ask the
    // accessibility tree the same questions.
    it("highlights the first row to start with", () => {
      const { active } = open();

      expect(active()?.textContent).toBe("main");
    });

    it("moves the highlight with the arrow keys", () => {
      const { input, active } = open();

      fireEvent.keyDown(input(), { key: "ArrowDown" });

      expect(active()?.textContent).toBe("develop");
    });

    it("follows the mouse", () => {
      const { rows, active } = open();

      fireEvent.mouseEnter(rows()[2]);

      expect(active()?.textContent).toBe("feature/omnibox");
    });

    it("pulls the highlight back into range when the filter shortens the list", () => {
      const { input, active } = open();

      fireEvent.keyDown(input(), { key: "ArrowUp" });
      type(input(), "omni");

      expect(active()?.textContent).toBe("feature/omnibox");
    });

    // A `mousedown` on a real backdrop element; Kobalte dismisses on an outside
    // `pointerdown` from a `setTimeout(0)` listener instead.
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
