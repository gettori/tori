import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import SpaceDialog from "./SpaceDialog";

// Characterization test for the space create/edit dialog, written against the
// hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#100). Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// One component, two dialogs: "new" creates a folder, so it validates the name
// and the name is permanent afterwards; "edit" creates nothing, so the name is
// read-only and the icon is the only editable field. Nearly every assertion
// below exists to keep those two apart, because the difference is expressed as
// `mode` reaching four separate places (title, field, validation, payload) and
// a migration that reshaped the body could easily keep three of them.
//
// The colour and icon pickers say what they are through `aria-pressed` and two
// named `role="group"`s, which is what makes them assertable without reading a
// class. That is worth noting next to `PickerModal`, in the same set, whose
// rows have no roles at all and whose highlight therefore *is* a class.
//
// **Accessibility baseline, measured before any migration edit, and the two
// modes do not agree.** New mode is clean: the name field carries no `<label>`
// and no `aria-label`, but it does carry `placeholder="space name"`, which axe
// accepts as an accessible name. Edit mode swaps that field for a disabled,
// readonly one with *no* placeholder, and axe reports `label` against it. So
// the new-mode assertion gates on everything from the first commit, and the
// edit-mode one disables that single rule with this reason; phase 3 of #100
// names the field in both modes and drops the override.
//
// Worth stating plainly, because it is the trap this baseline was measured to
// avoid: probing one mode of a two-mode dialog and calling the result "the
// dialog's baseline" would have hidden this, and the assertion written from it
// would have failed on the first migration edit, looking like the migration's
// fault.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

type Props = Parameters<typeof SpaceDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <SpaceDialog
      mode="new"
      name=""
      icon={null}
      color={null}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  const name = () => screen.getByPlaceholderText("space name") as HTMLInputElement;
  const search = () => screen.getByLabelText("Search icons") as HTMLInputElement;
  const swatches = () =>
    Array.from(
      screen.getByRole("group", { name: "Space colour" }).querySelectorAll("button"),
    );
  const tiles = () =>
    Array.from(
      screen.getByRole("group", { name: "Space icon" }).querySelectorAll("button"),
    );
  return { onConfirm, onCancel, name, search, swatches, tiles };
}

const submit = (label: string) =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("SpaceDialog", () => {
  describe("contract", () => {
    it("says it is creating, in new mode", () => {
      open();

      expect(screen.getByText("New space")).toBeTruthy();
      expect(submit("Create")).toBeTruthy();
    });

    it("says which space it is editing, in edit mode", () => {
      open({ mode: "edit", name: "work" });

      expect(screen.getByText("Edit “work”")).toBeTruthy();
      expect(submit("Save")).toBeTruthy();
    });

    it("warns that the name is permanent, while it can still be set", () => {
      open();

      expect(
        screen.getByText("The name can’t be changed later, but you can always change the icon."),
      ).toBeTruthy();
    });

    it("refuses to create a space with no name", () => {
      open();

      expect(screen.getByText("Name is empty")).toBeTruthy();
      expect(submit("Create").disabled).toBe(true);
    });

    it("refuses a name that would not be one folder", () => {
      const { name } = open();

      fireEvent.input(name(), { target: { value: "work/side" } });

      expect(screen.getByText("Name cannot contain a slash")).toBeTruthy();
      expect(submit("Create").disabled).toBe(true);
    });

    it("refuses a name that would hide the folder", () => {
      const { name } = open();

      fireEvent.input(name(), { target: { value: ".work" } });

      expect(screen.getByText("Name cannot start with a dot")).toBeTruthy();
      expect(submit("Create").disabled).toBe(true);
    });

    it("creates a trimmed name with the chosen icon and colour", () => {
      const { onConfirm, name, swatches, tiles } = open();

      fireEvent.input(name(), { target: { value: "  work  " } });
      fireEvent.click(swatches()[1]);
      fireEvent.click(tiles()[1]);

      fireEvent.click(submit("Create"));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      const arg = onConfirm.mock.calls[0][0];
      expect(arg.name).toBe("work");
      expect(arg.color).not.toBeNull();
      expect(arg.icon).not.toBeNull();
    });

    it("never renames in edit mode, whatever the field shows", () => {
      const { onConfirm } = open({ mode: "edit", name: "work" });

      fireEvent.click(submit("Save"));

      expect(onConfirm).toHaveBeenCalledWith({ name: "work", icon: null, color: null });
    });

    it("locks the name field in edit mode", () => {
      open({ mode: "edit", name: "work" });

      const field = document.querySelector<HTMLInputElement>(`input.${styles.modalInput}`)!;
      expect(field.value).toBe("work");
      expect(field.disabled).toBe(true);
      expect(screen.queryByPlaceholderText("space name")).toBeNull();
    });

    it("starts on the automatic colour, which follows the name", () => {
      const { swatches } = open();

      expect(swatches()[0].getAttribute("aria-pressed")).toBe("true");
    });

    it("starts on no icon", () => {
      const { tiles } = open();

      expect(tiles()[0].getAttribute("aria-pressed")).toBe("true");
      expect(tiles()[0].textContent).toBe("None");
    });

    it("preselects what the space already has", () => {
      const { swatches, tiles } = open({ mode: "edit", name: "work", icon: "Rocket", color: "Amber" });

      expect(swatches().some((b) => b.getAttribute("aria-pressed") === "true" && b.title === "Amber")).toBe(true);
      expect(tiles().some((b) => b.getAttribute("aria-pressed") === "true" && b.title === "Rocket")).toBe(true);
    });

    it("filters the icon grid, keeping None reachable", () => {
      const { search, tiles } = open();

      const all = tiles().length;
      fireEvent.input(search(), { target: { value: "rocket" } });

      expect(tiles().length).toBeLessThan(all);
      expect(tiles()[0].textContent).toBe("None");
    });

    it("clears the icon back to none", () => {
      const { onConfirm, tiles } = open({ mode: "edit", name: "work", icon: "Rocket", color: null });

      fireEvent.click(tiles()[0]);
      fireEvent.click(submit("Save"));

      expect(onConfirm).toHaveBeenCalledWith({ name: "work", icon: null, color: null });
    });

    it("confirms on Enter", () => {
      const { onConfirm, name } = open();

      fireEvent.input(name(), { target: { value: "work" } });
      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("ignores Enter while the name is invalid", () => {
      const { onConfirm, name } = open();

      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("ignores Enter while it is already working", () => {
      const { onConfirm, name } = open({ name: "work", busy: true });

      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(submit("Working…").disabled).toBe(true);
    });

    it("cancels on Escape", () => {
      const { onCancel, name } = open();

      fireEvent.keyDown(name(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the name field in new mode", async () => {
      const { name } = open();
      await frame();

      expect(document.activeElement).toBe(name());
    });

    it("has no accessibility violations creating a space", async () => {
      open();

      await expectNoAxeViolations(document.body);
    });

    it("has no accessibility violations editing one, bar the unnamed locked field", async () => {
      open({ mode: "edit", name: "work", icon: "Rocket", color: "Amber" });

      // See the file header: the read-only name field has no placeholder to
      // borrow a name from, so `label` fires here and not in new mode. Phase 3
      // of #100 fixes it; every other rule still runs.
      await expectNoAxeViolations(document.body, {
        rules: { label: { enabled: false } },
      });
    });
  });

  describe("shape", () => {
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
