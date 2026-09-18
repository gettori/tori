import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import SpaceDialog from "./SpaceDialog";

// Characterization test for the space create/edit dialog, written against the
// hand-rolled implementation, kept green across the migration onto
// `components/Dialog` (#100), and rewritten here when the three stacked pickers
// became a name and an appearance row. Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// One component, two dialogs: "new" creates a folder, so it validates the name
// and the name is permanent afterwards; "edit" creates nothing, so the name is
// a locked row and the appearance is the only thing left to change. Nearly
// every assertion below exists to keep those two apart, because the difference
// is expressed as `mode` reaching four separate places (title, field,
// validation, payload) and a change that reshaped the body could easily keep
// three of them.
//
// **The pickers are behind chips now**, which is the biggest change to how this
// file reaches them: neither group is in the document until its chip is
// pressed, so every assertion about a swatch or a tile opens its popover first.
// That is also why the appearance can no longer gate a submit - it arrives
// already chosen, and the only thing that can hold Create back is the name.
//
// The colour and icon pickers say what they are through `aria-pressed` and two
// named `role="group"`s, which is what makes them assertable without reading a
// class. That is worth noting next to `PickerModal`, in the same set, whose
// rows have no roles at all and whose highlight therefore *is* a class.
//
// **Accessibility, clean in both modes, by two different routes.** The phase-1
// baseline did not agree with itself: new mode passed, because the editable
// name field carries `placeholder="space name"` and axe accepts a placeholder
// as an accessible name, while edit mode swapped that field for a disabled,
// readonly one with no placeholder to borrow and axe reported `label` against
// it. New mode is now named by `aria-labelledby` pointing at the visible "Name"
// line, so the announcement matches what is on screen and the placeholder is
// back to being a hint. Edit mode has no control left to name: its name is
// static text, read in order after that same line.
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
      spaces={["work", "archive"]}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  // Asked through the accessibility tree: phase 3 named the field from its
  // visible "Name" line rather than from its placeholder (see the header). New
  // mode only - edit mode has no field, which is the point of it.
  const name = () => screen.getByLabelText("Name") as HTMLInputElement;
  // The panel itself, named rather than by role alone: an open picker is a
  // `role="dialog"` too, so the bare role is ambiguous whenever one is up.
  const panel = () => screen.getByRole("dialog", { name: /New space|Edit/ });
  const chip = (label: string) => screen.getByRole("button", { name: label });

  const group = (label: string) =>
    Array.from(screen.getByRole("group", { name: label }).querySelectorAll("button"));
  // Each picker opens its own popover, so reaching one is pressing its chip.
  // Idempotent on purpose: a test that picks twice should not have to track
  // whether the previous pick closed the panel (it did).
  const swatches = () => {
    if (!screen.queryByRole("group", { name: "Space colour" })) fireEvent.click(chip("Colour"));
    return group("Space colour");
  };
  const tiles = () => {
    if (!screen.queryByRole("group", { name: "Space icon" })) fireEvent.click(chip("Icon"));
    return group("Space icon");
  };
  const search = () => {
    tiles();
    return screen.getByLabelText("Search icons") as HTMLInputElement;
  };
  const pressed = (buttons: HTMLElement[]) =>
    buttons.find((b) => b.getAttribute("aria-pressed") === "true");

  return { onConfirm, onCancel, name, panel, chip, swatches, tiles, search, pressed };
}

const submit = (label: string) =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("SpaceDialog", () => {
  describe("contract", () => {
    it("says it is creating, in new mode", () => {
      open();

      expect(screen.getByText("New space")).toBeTruthy();
      expect(submit("Create space")).toBeTruthy();
    });

    it("says which space it is editing, in edit mode", () => {
      open({ mode: "edit", name: "work" });

      expect(screen.getByText("Edit “work”")).toBeTruthy();
      expect(submit("Save")).toBeTruthy();
    });

    it("says where the folder lands, while the name can still be set", () => {
      open();

      expect(
        screen.getByText("Becomes a folder in your base folder. Pick something short."),
      ).toBeTruthy();
    });

    it("says the name is the folder's, in edit mode", () => {
      open({ mode: "edit", name: "work" });

      expect(
        screen.getByText(
          "The folder on disk carries this name, so it can’t change here. Colour and icon can.",
        ),
      ).toBeTruthy();
    });

    // Empty is where the dialog starts, not a mistake the user has made, so it
    // holds the button and leaves the default help up rather than turning red.
    it("refuses to create a space with no name, without calling it an error", () => {
      open();

      expect(submit("Create space").disabled).toBe(true);
      expect(screen.queryByText("Name is empty")).toBeNull();
    });

    it("refuses a name another space in the base folder already has", () => {
      const { name } = open();

      fireEvent.input(name(), { target: { value: " WORK " } });

      expect(
        screen.getByText("A space named WORK already exists in this base folder."),
      ).toBeTruthy();
      expect(submit("Create space").disabled).toBe(true);
    });

    it("refuses a name that would not be one folder", () => {
      const { name } = open();

      fireEvent.input(name(), { target: { value: "work-side/nested" } });

      expect(screen.getByText("Name cannot contain a slash")).toBeTruthy();
      expect(submit("Create space").disabled).toBe(true);
    });

    it("refuses a name that would hide the folder", () => {
      const { name } = open();

      fireEvent.input(name(), { target: { value: ".side" } });

      expect(screen.getByText("Name cannot start with a dot")).toBeTruthy();
      expect(submit("Create space").disabled).toBe(true);
    });

    it("creates a trimmed name with the chosen icon and colour", () => {
      const { onConfirm, name, swatches, tiles } = open();

      fireEvent.input(name(), { target: { value: "  side  " } });
      fireEvent.click(swatches()[1]);
      fireEvent.click(tiles()[1]);

      fireEvent.click(submit("Create space"));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      const arg = onConfirm.mock.calls[0][0];
      expect(arg.name).toBe("side");
      expect(arg.color).not.toBeNull();
      expect(arg.icon).not.toBeNull();
    });

    it("never renames in edit mode, whatever is chosen", () => {
      const { onConfirm } = open({ mode: "edit", name: "work" });

      fireEvent.click(submit("Save"));

      expect(onConfirm).toHaveBeenCalledWith({ name: "work", icon: null, color: null });
    });

    it("locks the name in edit mode", () => {
      open({ mode: "edit", name: "work" });

      // Read in order after the "Name" line above it: static text, with nothing
      // to operate and so nothing to name.
      expect(screen.getByText("work")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
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

    // The point of the appearance row: a new space opens on a colour and an
    // icon, so neither picker can hold a submit back and the dialog is valid as
    // soon as it is named.
    it("opens on an appearance already chosen", () => {
      const { name, swatches, tiles, pressed } = open();
      fireEvent.input(name(), { target: { value: "side" } });

      expect(submit("Create space").disabled).toBe(false);
      // Not the leading tile in either picker, which is the "derive it" state.
      expect(pressed(swatches())).toBeTruthy();
      expect(pressed(swatches())).not.toBe(swatches()[0]);
      expect(pressed(tiles())).toBeTruthy();
      expect(pressed(tiles())).not.toBe(tiles()[0]);
    });

    it("rerolls both at once", () => {
      const { onConfirm, name, chip } = open();
      fireEvent.input(name(), { target: { value: "side" } });

      fireEvent.click(submit("Create space"));
      const before = onConfirm.mock.calls[0][0];

      fireEvent.click(chip("Reroll the colour and icon"));
      fireEvent.click(submit("Create space"));
      const after = onConfirm.mock.calls[1][0];

      // A reroll can land on what was already there, so this pins that it lands
      // on a *valid* pair rather than that it always differs.
      expect(after.color).not.toBeNull();
      expect(after.icon).not.toBeNull();
      expect(after.name).toBe(before.name);
    });

    it("preselects what the space already has", () => {
      const { swatches, tiles } = open({ mode: "edit", name: "work", icon: "Rocket", color: "Amber" });

      // By accessible name, not `title`: the swatches and tiles are tooltips
      // now, and each names itself with the `aria-label` the colour or icon
      // grid gives it (issue 102).
      const named = (b: HTMLElement) => b.getAttribute("aria-label");
      expect(swatches().some((b) => b.getAttribute("aria-pressed") === "true" && named(b) === "Amber")).toBe(true);
      expect(tiles().some((b) => b.getAttribute("aria-pressed") === "true" && named(b) === "Rocket")).toBe(true);
    });

    it("filters the icon grid, keeping the no-icon tile reachable", () => {
      const { search, tiles } = open({ mode: "edit", name: "group-2" });

      const all = tiles().length;
      fireEvent.input(search(), { target: { value: "rocket" } });

      expect(tiles().length).toBeLessThan(all);
      // It wears the initials it would fall back to, so what "no icon" means is
      // on the tile rather than only in its name.
      expect(tiles()[0].getAttribute("aria-label")).toBe("No icon - use initials");
      expect(tiles()[0].textContent).toBe("G");
    });

    it("clears the icon back to none", () => {
      const { onConfirm, tiles } = open({ mode: "edit", name: "work", icon: "Rocket", color: null });

      fireEvent.click(tiles()[0]);
      fireEvent.click(submit("Save"));

      expect(onConfirm).toHaveBeenCalledWith({ name: "work", icon: null, color: null });
    });

    // Added with #109. The automatic swatch previews the hue the space would
    // derive if no colour is chosen, so it has to follow the name as it is
    // typed - the one place the picker depends on a field outside it, and the
    // one thing a reshuffle of this body could quietly have frozen.
    it("keeps the automatic swatch previewing the name being typed", () => {
      const { name, swatches } = open();
      const auto = () => swatches()[0].getAttribute("style");
      const before = auto();

      fireEvent.input(name(), { target: { value: "telemetry" } });

      expect(auto()).not.toBe(before);
    });

    it("confirms on Enter", () => {
      const { onConfirm, name } = open();

      fireEvent.input(name(), { target: { value: "side" } });
      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    // Added with #109, and a deliberate change of behaviour rather than a
    // characterization of the old one. Before the pickers moved onto `IconGrid`
    // the dialog's own `onKeyDown` saw every Enter, including one aimed at a
    // tile: it cancelled the button's activation and submitted, so the grid had
    // no keyboard activation at all. `IconGrid` stops both activation keys at
    // the group, so Enter on a tile picks that tile and confirming needs focus
    // outside the picker.
    it("picks a tile on Enter rather than confirming from inside the picker", () => {
      const { onConfirm, tiles, name } = open();
      fireEvent.input(name(), { target: { value: "side" } });

      fireEvent.keyDown(tiles()[0], { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(tiles()[0].getAttribute("aria-pressed")).toBe("true");

      // The field still confirms, so the change is scoped to the picker.
      fireEvent.keyDown(name(), { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("ignores Enter while the name is invalid", () => {
      const { onConfirm, name } = open();

      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("ignores Enter while it is already working", () => {
      const { onConfirm, name } = open({ name: "side", busy: true });

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

    it("has no accessibility violations with a picker open", async () => {
      const { tiles } = open();
      tiles();

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
      const { onCancel, panel } = open();
      await macrotask();

      fireEvent.pointerDown(panel());

      expect(onCancel).not.toHaveBeenCalled();
    });

    // One at a time: the two panels overlap, so the second would open under the
    // first and read as the chip having done nothing.
    it("closes the colour picker when the icon picker opens", () => {
      const { chip, swatches } = open();
      swatches();

      fireEvent.click(chip("Icon"));

      expect(screen.queryByRole("group", { name: "Space colour" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Space icon" })).toBeTruthy();
    });
  });
});

// The `mount` seam, on a real dialog rather than the synthetic one in
// `Tooltip.test.tsx`. `Dialog.Content` calls Kobalte's `createHideOutside`,
// which aria-hides everything outside the panel, so a tooltip portalled onto
// the body would be styled correctly and invisible to a screen reader. The
// panel publishes itself through `Dialog/surface.ts`, and both `Tooltip` and
// `Popover` mount into it - which is why the swatch below, two portals deep,
// is still inside the dialog.
describe("a tooltip inside this dialog", () => {
  it("portals into the panel, not into the aria-hidden document", async () => {
    const { swatches, panel } = open();
    swatches();
    const swatch = screen.getByRole("button", { name: "Automatic (from the name)" });

    swatch.focus();
    fireEvent.focus(swatch);
    const tooltip = screen.getByRole("tooltip");
    // `ariaHideOutside` writes the attribute from inside a `setTimeout` and
    // then a `requestAnimationFrame`, so a synchronous assertion would read the
    // tree before it lands and pass either way.
    await new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(null))));

    expect(panel().contains(tooltip)).toBe(true);
    expect(tooltip.closest("[aria-hidden='true']")).toBeNull();
  });
});
