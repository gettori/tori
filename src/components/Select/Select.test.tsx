import { describe, it, expect, vi } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick } from "../../test/menus";
import Select, { type SelectGroup, type SelectOption } from "./Select";

// Kobalte's focus scope and dismissable layer both arm from `setTimeout(0)`,
// the same seam `Dropdown.test.tsx` documents: assert without yielding and you
// are asserting on machinery that does not exist yet.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

const FRUIT: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "grapes", label: "Grapes", disabled: true },
  { value: "pineapple", label: "Pineapple" },
];

const GROUPED: SelectGroup[] = [
  { label: "Bundled", options: [{ value: "dark", label: "Dark+" }] },
  { label: "Yours", options: [{ value: "custom", label: "Custom" }] },
];

/** The trigger, by the accessible name every consumer is required to give it.
 *  Not by role: whether Kobalte exposes the button as `button` or `combobox`
 *  is its business, and the queries here should outlive that choice. */
const trigger = () => screen.getByLabelText("Fruit");

const options = () =>
  screen.getAllByRole("option").map((o) => ({
    label: o.textContent,
    selected: o.getAttribute("aria-selected") === "true",
  }));

describe("Select", () => {
  it("shows the selected option's label, and an unknown value shows nothing", () => {
    const [value, setValue] = createSignal("banana");
    render(() => <Select options={FRUIT} value={value()} onChange={() => {}} aria-label="Fruit" />);

    expect(trigger().textContent).toContain("Banana");

    // The empty render is the wrapper's documented answer for a value naming no
    // option; resolving what absence *means* belongs to the call site.
    setValue("gone");
    expect(trigger().textContent).not.toContain("Banana");
  });

  it("round-trips a pointer selection as the option's string value", async () => {
    const [value, setValue] = createSignal("apple");
    const onChange = vi.fn((v: string) => setValue(v));
    render(() => <Select options={FRUIT} value={value()} onChange={onChange} aria-label="Fruit" />);

    pointerClick(trigger());
    await screen.findByRole("listbox");
    expect(options().find((o) => o.selected)?.label).toContain("Apple");

    pointerClick(screen.getByRole("option", { name: "Banana" }));
    await macrotask();

    expect(onChange).toHaveBeenCalledWith("banana");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toContain("Banana");
  });

  it("ignores a press on a disabled option", async () => {
    const onChange = vi.fn();
    render(() => <Select options={FRUIT} value="apple" onChange={onChange} aria-label="Fruit" />);

    pointerClick(trigger());
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Grapes" }));
    await macrotask();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("opens from the keyboard and commits with Enter", async () => {
    const [value, setValue] = createSignal("apple");
    render(() => <Select options={FRUIT} value={value()} onChange={setValue} aria-label="Fruit" />);

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    await macrotask();

    // Kobalte gives the listbox roving focus: the arrows move focus onto the
    // rows themselves, so the commit key goes to the focused row rather than to
    // the listbox. Same split `Dropdown.test.tsx` drives its menus with.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await macrotask();

    expect(value()).toBe("banana");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("typeahead selects without opening the listbox", async () => {
    const [value, setValue] = createSignal("apple");
    render(() => <Select options={FRUIT} value={value()} onChange={setValue} aria-label="Fruit" />);

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "p" });
    await macrotask();

    expect(value()).toBe("pineapple");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders group headings, and grouped rows still commit", async () => {
    const [value, setValue] = createSignal("dark");
    render(() => <Select options={GROUPED} value={value()} onChange={setValue} aria-label="Fruit" />);

    pointerClick(trigger());
    await screen.findByRole("listbox");

    expect(screen.getByText("Bundled")).toBeTruthy();
    expect(screen.getByText("Yours")).toBeTruthy();

    pointerClick(screen.getByRole("option", { name: "Custom" }));
    await macrotask();
    expect(value()).toBe("custom");
  });

  // The guard against normalizing the options at setup time: AppearancePane's
  // list arrives from a folder watcher, so a snapshot taken once would pin
  // whatever themes existed at mount. Swapped while *closed*, which is the real
  // sequence - a new array while the listbox is open resets Kobalte's list
  // state and closes it, which is its behaviour rather than a Tori choice.
  it("an options list swapped after mount reaches the next open", async () => {
    const [opts, setOpts] = createSignal<SelectOption[]>(FRUIT);
    render(() => <Select options={opts()} value="apple" onChange={() => {}} aria-label="Fruit" />);

    setOpts([...FRUIT, { value: "mango", label: "Mango" }]);
    await macrotask();

    pointerClick(trigger());
    await screen.findByRole("listbox");
    expect(options()).toHaveLength(5);
    expect(screen.getByRole("option", { name: "Mango" })).toBeTruthy();
  });

  it("a disabled select does not open", async () => {
    render(() => <Select options={FRUIT} value="apple" onChange={() => {}} disabled aria-label="Fruit" />);

    pointerClick(trigger());
    await macrotask();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("takes its accessible name from an external label via aria-labelledby", () => {
    render(() => (
      <>
        <span id="row-label">Transcript density</span>
        <Select options={FRUIT} value="apple" onChange={() => {}} aria-labelledby="row-label" />
      </>
    ));

    expect(screen.getByLabelText(/Transcript density/)).toBeTruthy();
  });

  it("has no axe violations, closed or open", async () => {
    render(() => <Select options={FRUIT} value="apple" onChange={() => {}} aria-label="Fruit" />);

    await expectNoAxeViolations(document.body);

    pointerClick(trigger());
    await screen.findByRole("listbox");
    await macrotask();
    // Body-scoped: the listbox is portalled, a sibling of the container.
    //
    // `aria-valid-attr-value` off for this one scan, for the reason
    // `Dropdown.test.tsx` records: axe's `controlsWithinPopup` declines to
    // judge `aria-controls` on any element carrying `aria-haspopup`, because it
    // cannot tell whether the popup is open - in a real browser as much as
    // here. An open Kobalte select trigger carries both. The closed scan above
    // runs the rule in full; a closed trigger has no `aria-controls` at all.
    await expectNoAxeViolations(document.body, {
      rules: { "aria-valid-attr-value": { enabled: false } },
    });
  });
});
