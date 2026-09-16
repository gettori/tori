import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { Combobox } from "./combobox";

// The smoke test for the `lib/` seam, not for Kobalte's combobox, the same job
// `dialog.test.tsx` does and for the same reason: Kobalte is inlined by
// `vitest.config.ts`, and neither half of that config is visible until a part is
// actually mounted.
//
// The composition here is the one Tori actually ships, which is the unusual
// part and worth pinning at this level: no `Content` and no `Portal`. Those are
// where a Kobalte combobox normally puts its list, and skipping them is what
// lets the list render inline inside a surface that already owns dismissal and
// focus. If a future Kobalte version stops rendering `Listbox` outside
// `Content`, this fails here rather than three components up.
describe("the Kobalte combobox, through src/lib", () => {
  it("renders an inline listbox with no Content or Portal, wired to the input", () => {
    render(() => (
      <Combobox.Root<{ value: string; label: string }>
        options={[
          { value: "a", label: "alpha" },
          { value: "b", label: "beta" },
        ]}
        optionValue="value"
        optionTextValue="label"
        optionLabel="label"
        open
        itemComponent={(props) => (
          <Combobox.Item item={props.item}>
            <Combobox.ItemLabel>{props.item.rawValue.label}</Combobox.ItemLabel>
          </Combobox.Item>
        )}
      >
        <Combobox.Control>
          <Combobox.Input aria-label="Filter" />
        </Combobox.Control>
        <Combobox.Listbox />
      </Combobox.Root>
    ));

    const input = screen.getByRole("combobox");
    const listbox = screen.getByRole("listbox");

    // In the render container, not portalled off the body: the whole point of
    // composing without `Portal`.
    expect(document.body.contains(listbox)).toBe(true);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["alpha", "beta"]);

    // The wiring Tori adopted Kobalte *for*: the input names the list it drives
    // rather than merely sitting above it.
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the surrounding document alone, having no modality of its own", () => {
    render(() => (
      <div>
        <p>sibling</p>
        <Combobox.Root<{ value: string; label: string }>
          options={[{ value: "a", label: "alpha" }]}
          optionValue="value"
          optionTextValue="label"
          optionLabel="label"
          open
          itemComponent={(props) => (
            <Combobox.Item item={props.item}>
              <Combobox.ItemLabel>{props.item.rawValue.label}</Combobox.ItemLabel>
            </Combobox.Item>
          )}
        >
          <Combobox.Control>
            <Combobox.Input aria-label="Filter" />
          </Combobox.Control>
          <Combobox.Listbox />
        </Combobox.Root>
      </div>
    ));

    // `Content` would have called `createHideOutside` and aria-hidden'd this.
    // Its absence is the reason the picker's own dialog title survives.
    expect(screen.getByText("sibling").closest("[aria-hidden='true']")).toBeNull();
  });
});
