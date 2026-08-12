import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
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
// **Accessibility, now clean in both modes.** The phase-1 baseline did not
// agree with itself: new mode passed, because the editable name field carries
// `placeholder="space name"` and axe accepts a placeholder as an accessible
// name, while edit mode swapped that field for a disabled, readonly one with no
// placeholder to borrow and axe reported `label` against it. Both fields are
// now named by `aria-labelledby` pointing at the same visible "Name" line, so
// the announcement matches what is on screen, the placeholder is back to being
// a hint, and the rule override is gone.
//
// Worth stating plainly, because it is the trap that baseline was measured to
// avoid: probing one mode of a two-mode dialog and calling the result "the
// dialog's baseline" would have hidden the edit-mode violation, and the
// assertion written from it would have failed on the first migration edit,
// looking like the migration's fault.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  // Asked through the accessibility tree in both modes: phase 3 named the field
  // from its visible "Name" line, and edit mode's copy has no placeholder to be
  // found by (see the header).
  const name = () => screen.getByLabelText("Name") as HTMLInputElement;
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
      const { name } = open({ mode: "edit", name: "work" });

      expect(name().value).toBe("work");
      expect(name().disabled).toBe(true);
      expect(screen.queryByPlaceholderText("space name")).toBeNull();
    });

    // The placeholder used to be the field's only accessible name, which meant
    // the announcement vanished the moment anything was typed. It is a hint
    // again now, and the visible "Name" line is what a screen reader reads.
    it("names the field from the line above it, not from the placeholder", () => {
      const { name } = open();

      expect(name().placeholder).toBe("space name");
      expect(name()).toBe(screen.getByPlaceholderText("space name"));
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

    it("has no accessibility violations editing one", async () => {
      open({ mode: "edit", name: "work", icon: "Rocket", color: "Amber" });

      await expectNoAxeViolations(document.body);
    });
  });

  describe("shape", () => {
    // Rewritten at migration time: dismissal was a `mousedown` on a real
    // backdrop element and is now Kobalte's outside `pointerdown`, from a
    // listener it installs in a `setTimeout(0)`.
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
