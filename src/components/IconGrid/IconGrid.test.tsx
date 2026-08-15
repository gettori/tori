import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import IconGrid, { type IconGridTile } from "./IconGrid";

// Twenty tiles at eight columns: three rows, the last one short, which is what
// makes the clamp assertions below mean something.
const GLYPHS: IconGridTile[] = Array.from({ length: 20 }, (_, i) => ({
  value: `icon-${i}`,
  label: `Icon ${i}`,
  content: <svg aria-hidden="true" />,
}));

function openGrid(
  props: Partial<Parameters<typeof IconGrid>[0]> = {},
  initial: string | null = null,
) {
  const [value, setValue] = createSignal<string | null>(initial);
  const onChange = vi.fn((next: string | null) => setValue(next));
  render(() => (
    <IconGrid
      aria-label="Project icon"
      value={value()}
      onChange={onChange}
      tiles={(q) => GLYPHS.filter((g) => g.label.toLowerCase().includes(q.toLowerCase()))}
      {...props}
    />
  ));
  const group = () => screen.getByRole("group", { name: "Project icon" });
  const tiles = () => Array.from(group().querySelectorAll("button"));
  const named = (name: string) =>
    screen.getByRole("button", { name }) as HTMLButtonElement;
  return { onChange, value, group, tiles, named };
}

describe("IconGrid", () => {
  describe("selection", () => {
    it("reports the tile that was pressed", () => {
      const { onChange, named } = openGrid();

      fireEvent.click(named("Icon 3"));

      expect(onChange).toHaveBeenCalledWith("icon-3");
    });

    it("keeps exactly one tile selected", () => {
      const { tiles, named } = openGrid({}, "icon-3");
      expect(named("Icon 3").getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(named("Icon 7"));

      const pressed = tiles().filter((t) => t.getAttribute("aria-pressed") === "true");
      expect(pressed).toHaveLength(1);
      expect(pressed[0].getAttribute("aria-label")).toBe("Icon 7");
    });

    // Kobalte's single mode reports `null` when the pressed item is pressed
    // again. Neither consumer has an empty state, so that change is dropped and
    // the tile stays chosen.
    it("refuses to clear the selection by pressing the chosen tile", () => {
      const { onChange, named } = openGrid({}, "icon-3");

      fireEvent.click(named("Icon 3"));

      expect(onChange).not.toHaveBeenCalled();
      expect(named("Icon 3").getAttribute("aria-pressed")).toBe("true");
    });

    it("selects the leading tile as null, and holds it while the query filters", () => {
      const { onChange, tiles, named } = openGrid({
        leading: { label: "No icon", content: "None" },
        search: { label: "Search icons", placeholder: "Search icons" },
      }, "icon-3");

      fireEvent.input(screen.getByLabelText("Search icons"), {
        target: { value: "Icon 1" },
      });

      // Still first, and still there, though it matches no query.
      expect(tiles()[0].getAttribute("aria-label")).toBe("No icon");

      fireEvent.click(named("No icon"));

      expect(onChange).toHaveBeenCalledWith(null);
    });
  });

  describe("keyboard", () => {
    it("selects the focused tile on Space and on Enter", () => {
      const { onChange, named } = openGrid();

      fireEvent.keyDown(named("Icon 5"), { key: " " });
      expect(onChange).toHaveBeenCalledWith("icon-5");

      onChange.mockClear();
      fireEvent.keyDown(named("Icon 9"), { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("icon-9");
    });

    // The surface this sits in confirms on a bubbling Enter, so a keystroke that
    // escaped would pick a tile and submit the dialog in one go.
    it("keeps Enter and Space from escaping the group", () => {
      const outer = vi.fn();
      render(() => (
        <div onKeyDown={outer}>
          <IconGrid
            aria-label="Space icon"
            value={null}
            onChange={() => {}}
            tiles={() => GLYPHS}
          />
        </div>
      ));

      const tile = screen.getAllByRole("button", { name: "Icon 2" })[0];
      fireEvent.keyDown(tile, { key: "Enter" });
      fireEvent.keyDown(tile, { key: " " });

      expect(outer).not.toHaveBeenCalled();
    });

    // The primitive's own vertical keys resolve to nothing at all (see the
    // module comment), so without this handler ArrowDown is a dead key in a set
    // that is visibly eight wide.
    it("moves a whole row on ArrowDown and ArrowUp", () => {
      const { named } = openGrid();

      named("Icon 0").focus();
      fireEvent.keyDown(named("Icon 0"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(named("Icon 8"));

      fireEvent.keyDown(named("Icon 8"), { key: "ArrowUp" });
      expect(document.activeElement).toBe(named("Icon 0"));
    });

    it("stays put at the top row and past the end of a short last row", () => {
      const { named } = openGrid();

      named("Icon 2").focus();
      fireEvent.keyDown(named("Icon 2"), { key: "ArrowUp" });
      expect(document.activeElement).toBe(named("Icon 2"));

      // Row three holds icons 16 to 19, so a row below 18 is off the end.
      named("Icon 18").focus();
      fireEvent.keyDown(named("Icon 18"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(named("Icon 18"));
    });

    // A wrapped single row has no second axis, so the swatch variant hands the
    // whole keyboard back: Left and Right step, and the primitive's inert
    // vertical keys stay inert rather than being taught a row width that the
    // wrapping makes up as it goes.
    it("leaves the swatch row's arrows to the primitive", () => {
      const { named } = openGrid({ variant: "swatch" });

      named("Icon 0").focus();
      // The primitive only learns which tile is focused from the event itself;
      // the row tests above never need this because their own handler moves
      // focus rather than asking the primitive to.
      fireEvent.focus(named("Icon 0"));
      fireEvent.focusIn(named("Icon 0"));

      fireEvent.keyDown(named("Icon 0"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(named("Icon 1"));

      fireEvent.keyDown(named("Icon 1"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(named("Icon 1"));
    });

    it("keeps the search field's own caret keys", () => {
      openGrid({ search: { label: "Search icons", placeholder: "Search icons" } });
      const search = screen.getByLabelText("Search icons") as HTMLInputElement;

      search.focus();
      fireEvent.keyDown(search, { key: "ArrowLeft" });
      fireEvent.keyDown(search, { key: "Home" });

      // The group's roving focus never took over: had the field been inside the
      // group, Kobalte would have moved focus onto a tile and cancelled the
      // caret move on its way.
      expect(document.activeElement).toBe(search);
    });
  });

  // `SpaceDialog`'s leading swatch previews the hue the space would derive from
  // its name, so it changes under the user while they type in a field this
  // component never sees. Reading the spec once at mount would freeze that
  // preview on the hue of the empty name.
  it("follows a leading tile whose spec changes", () => {
    const [seed, setSeed] = createSignal("10 20 30");
    render(() => (
      <IconGrid
        variant="swatch"
        aria-label="Space colour"
        value={null}
        onChange={() => {}}
        leading={{ label: "Automatic", tint: seed() }}
        tiles={() => []}
      />
    ));
    const auto = () => screen.getByRole("button", { name: "Automatic" });
    expect(auto().getAttribute("style")).toContain("10 20 30");

    setSeed("99 98 97");

    expect(auto().getAttribute("style")).toContain("99 98 97");
  });

  describe("tab stop", () => {
    it("holds the stop on the group until a tile takes focus", () => {
      const { group, named } = openGrid();
      expect(group().getAttribute("tabindex")).toBe("0");

      named("Icon 4").focus();
      fireEvent.focus(named("Icon 4"));

      expect(group().getAttribute("tabindex")).toBe("-1");
      expect(named("Icon 4").getAttribute("tabindex")).toBe("0");
    });

    // Kobalte parks the stop on its focused item and never clears that key when
    // the item unmounts, so filtering the focused tile away leaves every item at
    // -1 with the container at -1 too, and the grid falls out of the tab order.
    it("takes the stop back when the query filters the focused tile away", () => {
      const { group, named } = openGrid({
        search: { label: "Search icons", placeholder: "Search icons" },
      });

      named("Icon 4").focus();
      fireEvent.focus(named("Icon 4"));
      expect(group().getAttribute("tabindex")).toBe("-1");

      fireEvent.input(screen.getByLabelText("Search icons"), {
        target: { value: "Icon 11" },
      });

      expect(group().querySelectorAll("button")).toHaveLength(1);
      expect(group().getAttribute("tabindex")).toBe("0");
    });

    it("survives a query that matches nothing", () => {
      const { group } = openGrid({
        search: { label: "Search icons", placeholder: "Search icons" },
      });

      fireEvent.input(screen.getByLabelText("Search icons"), {
        target: { value: "nothing here" },
      });

      expect(group().querySelectorAll("button")).toHaveLength(0);
      expect(group().getAttribute("tabindex")).toBe("0");
    });
  });

  describe("accessibility", () => {
    it("has no violations as a grid", async () => {
      openGrid({
        leading: { label: "No icon", content: "None" },
        search: { label: "Search icons", placeholder: "Search icons" },
      });

      await expectNoAxeViolations(document.body);
    });

    it("has no violations as a swatch row", async () => {
      openGrid({
        variant: "swatch",
        leading: { label: "Automatic", tint: "120 80 40" },
      });

      await expectNoAxeViolations(document.body);
    });
  });
});
