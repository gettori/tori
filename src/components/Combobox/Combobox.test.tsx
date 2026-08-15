import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import Combobox, { type ComboboxGroup, type ComboboxOption } from "./Combobox";

// The contract of the shared filter-and-pick surface (#110), asked of the
// accessibility tree rather than of a CSS Module class, per
// lesson_characterize_the_contract_not_the_shape.
//
// Two of these cases exist because the primitive does *not* do the thing on its
// own, and would regress silently if the wrapper's `Bridge` were ever deleted
// as dead code: Kobalte only highlights a row inside its own `open()`, which a
// combobox that is open from birth never calls, and it clears the highlight on
// every keystroke. "starts on the first row" and "keeps the top match under
// Enter while typing" are those two.
//
// The third is a genuine change of shape from the hand-rolled pickers: the
// active row is `data-highlighted` and `aria-activedescendant`, *not*
// `aria-selected`. In a combobox `aria-selected` means the committed value, and
// both consumers commit and close, so no visible row ever carries it.

const OPTIONS: ComboboxOption[] = [
  { value: "main", label: "main" },
  { value: "develop", label: "develop" },
  { value: "feature/omnibox", label: "feature/omnibox" },
];

/** A caller, doing its own filtering the way the real ones do. */
function host(all: ComboboxOption[] = OPTIONS) {
  const onSelect = vi.fn();
  const [query, setQuery] = createSignal("");
  const options = () => all.filter((o) => o.label.includes(query().trim()));

  render(() => (
    <Combobox
      aria-label="Filter branches"
      listLabel="Branches"
      emptyLabel="No matches"
      placeholder="Filter branches"
      options={options()}
      query={query()}
      onQueryChange={setQuery}
      onSelect={(v) => onSelect(v)}
    />
  ));

  const input = () => screen.getByRole("combobox") as HTMLInputElement;
  const rows = () => screen.queryAllByRole("option");
  // The active row as a screen reader would resolve it: follow the input's
  // `aria-activedescendant` to the row it names.
  const active = () => {
    const id = input().getAttribute("aria-activedescendant");
    return id ? rows().find((r) => r.id === id) : undefined;
  };
  return { onSelect, input, rows, active, setQuery };
}

const type = (el: HTMLInputElement, value: string) => fireEvent.input(el, { target: { value } });
const press = (el: HTMLElement, key: string) => fireEvent.keyDown(el, { key });

describe("Combobox", () => {
  describe("contract", () => {
    it("offers every row before anything is typed", () => {
      const { rows } = host();
      expect(rows().map((r) => r.textContent)).toEqual(["main", "develop", "feature/omnibox"]);
    });

    it("starts on the first row, so Enter commits without touching an arrow key", () => {
      const { input, onSelect } = host();
      press(input(), "Enter");
      expect(onSelect).toHaveBeenCalledWith("main");
    });

    it("narrows the list as the filter is typed", () => {
      const { input, rows } = host();
      type(input(), "dev");
      expect(rows().map((r) => r.textContent)).toEqual(["develop"]);
    });

    it("keeps the top match under Enter while typing, rather than the row that was first before", () => {
      const { input, onSelect } = host();
      type(input(), "dev");
      press(input(), "Enter");
      expect(onSelect).toHaveBeenCalledWith("develop");
    });

    it("moves the highlight down and commits what it lands on", () => {
      const { input, onSelect } = host();
      press(input(), "ArrowDown");
      press(input(), "Enter");
      expect(onSelect).toHaveBeenCalledWith("develop");
    });

    it("wraps from the last row back to the first", () => {
      const { input, onSelect } = host();
      press(input(), "ArrowUp");
      press(input(), "Enter");
      expect(onSelect).toHaveBeenCalledWith("feature/omnibox");
    });

    it("commits the row that is clicked", () => {
      const { rows, onSelect } = host();
      fireEvent.click(rows()[2]);
      expect(onSelect).toHaveBeenCalledWith("feature/omnibox");
    });

    it("writes the filter text when the caller changes it, including back to empty", () => {
      const { input, setQuery, rows } = host();
      setQuery("dev");
      expect(input().value).toBe("dev");
      expect(rows()).toHaveLength(1);
      setQuery("");
      expect(input().value).toBe("");
      expect(rows()).toHaveLength(3);
    });

    it("withdraws the list when nothing matches, and points nowhere", () => {
      const { input, rows } = host();
      type(input(), "zzz");
      expect(rows()).toHaveLength(0);
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(input().getAttribute("aria-controls")).toBeNull();
      expect(input().getAttribute("aria-activedescendant")).toBeNull();
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("skips a disabled row rather than landing on it", () => {
      const { input, onSelect } = host([
        { value: "a", label: "alpha" },
        { value: "b", label: "beta", disabled: true },
        { value: "c", label: "gamma" },
      ]);
      press(input(), "ArrowDown");
      press(input(), "Enter");
      expect(onSelect).toHaveBeenCalledWith("c");
    });

    it("names a group's rows with its heading", () => {
      const groups: ComboboxGroup[] = [
        { label: "Recently visited", options: [{ value: "a", label: "alpha" }] },
        { label: "Everything else", options: [{ value: "b", label: "beta" }] },
      ];
      render(() => (
        <Combobox
          aria-label="Filter"
          options={groups}
          query=""
          onQueryChange={() => {}}
          onSelect={() => {}}
        />
      ));
      expect(screen.getByText("Recently visited")).toBeTruthy();
      expect(screen.getByText("Everything else")).toBeTruthy();
      expect(screen.getAllByRole("option").map((r) => r.textContent)).toEqual(["alpha", "beta"]);
    });

    // Kobalte builds every section node with `key: ""` and the listbox renders
    // the collection through `<Key by="key">`, so two headings are two entries
    // claiming one key. A first render survives that; an update does not, and a
    // list that grows a second heading comes back with one, in the other one's
    // place. The palette hits this the moment its project files arrive under the
    // recent blocks, so the wrapper rebuilds the list when the headings change.
    it("keeps every heading when a group is added to a list that already had one", () => {
      const [groups, setGroups] = createSignal<ComboboxGroup[]>([
        { label: "Recently visited", options: [{ value: "a", label: "alpha" }] },
      ]);
      render(() => (
        <Combobox
          aria-label="Filter"
          options={groups()}
          query=""
          onQueryChange={() => {}}
          onSelect={() => {}}
        />
      ));
      expect(screen.getByText("Recently visited")).toBeTruthy();

      setGroups((prev) => [...prev, { label: "Everything else", options: [{ value: "b", label: "beta" }] }]);

      expect(screen.getByText("Recently visited")).toBeTruthy();
      expect(screen.getByText("Everything else")).toBeTruthy();
      expect(screen.getAllByRole("option").map((r) => r.textContent)).toEqual(["alpha", "beta"]);
    });
  });

  describe("shape", () => {
    it("announces the list as a listbox the filter drives", () => {
      const { input } = host();
      const listbox = screen.getByRole("listbox");
      expect(input().getAttribute("aria-controls")).toBe(listbox.id);
      expect(input().getAttribute("aria-expanded")).toBe("true");
    });

    // The prop survives only because Kobalte spreads its own `others` last over
    // the `aria-label` it computes from context. Pinned here so a reordering
    // upstream fails loudly instead of quietly leaving the list unnamed.
    it("names the list with the caller's label", () => {
      host();
      expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Branches");
    });

    // Withdrawing the list also withdraws Kobalte's count announcement, which is
    // gated on the open state, so without this the one moment a filter has
    // nothing to say is the one moment it says nothing.
    it("announces that nothing matched, rather than going silent", () => {
      const { input } = host();
      type(input(), "zzz");
      expect(screen.getByRole("status").textContent).toBe("No matches");
    });

    it("marks the active row with data-highlighted, and selects nothing", () => {
      const { input, rows, active } = host();
      press(input(), "ArrowDown");
      expect(active()).toBe(rows()[1]);
      expect(rows()[1].hasAttribute("data-highlighted")).toBe(true);
      expect(rows()[0].hasAttribute("data-highlighted")).toBe(false);
      // The committed value, which these pickers never have while open.
      expect(rows().every((r) => r.getAttribute("aria-selected") === "false")).toBe(true);
    });

    it("pulls the highlight back into range when the filter drops the active row", () => {
      const { input, rows, active } = host();
      press(input(), "ArrowUp");
      expect(active()).toBe(rows()[2]);
      type(input(), "dev");
      expect(active()).toBe(rows()[0]);
    });

    // Focused, because that is the only state these surfaces are ever in: both
    // put focus in the field as they open and keep it there, since the list is
    // driven by `aria-activedescendant` rather than by moving focus.
    //
    // `aria-valid-attr-value` off for this one scan, for the reason
    // `Select.test.tsx` and `Dropdown.test.tsx` record: axe's
    // `controlsWithinPopup` declines to judge `aria-controls` on any element
    // carrying `aria-haspopup`, because it cannot tell whether the popup is
    // open, in a real browser as much as here. Kobalte's combobox input carries
    // both. What the rule would have checked is asserted directly in "announces
    // the list as a listbox the filter drives" instead.
    it("has no accessibility violations", async () => {
      const { input } = host();
      input().focus();
      await expectNoAxeViolations(document.body, {
        rules: { "aria-valid-attr-value": { enabled: false } },
      });
    });

    // The collapsed scan, which runs that rule in full: with nothing to pick
    // the combobox carries no `aria-controls` at all, so there is nothing for
    // `controlsWithinPopup` to decline. This is the case that would have caught
    // an `aria-expanded="true"` left pointing at a withdrawn list.
    it("has no accessibility violations with nothing left to pick", async () => {
      const { input } = host();
      input().focus();
      type(input(), "zzz");
      await expectNoAxeViolations(document.body);
    });
  });
});
