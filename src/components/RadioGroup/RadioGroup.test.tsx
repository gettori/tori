import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import RadioGroup, { type RadioOption } from "./RadioGroup";
import styles from "./RadioGroup.module.css";
import { expectNoAxeViolations } from "../../test/axe";

// What this suite holds is the contract a consumer depends on: real native
// radios in the accessibility tree, a controlled value that includes "nothing
// chosen", and the description announced with the option it belongs to. The
// circle and dot are CSS, which jsdom has no opinion about, so nothing here
// asserts on appearance.

const OPTIONS: RadioOption[] = [
  { value: "inline", label: "Inline", description: "Stays in the transcript" },
  { value: "modal", label: "Modal" },
  { value: "sheet", label: "Sheet", disabled: true },
];

function renderControlled(over: Partial<Parameters<typeof RadioGroup>[0]> = {}) {
  const [value, setValue] = createSignal<string | null>(null);
  const r = render(() => (
    <RadioGroup
      options={OPTIONS}
      value={value()}
      onChange={setValue}
      label="Where should it render?"
      {...over}
    />
  ));
  return { ...r, value };
}

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("RadioGroup", () => {
  it("renders native radio inputs, so the arrow keys work without any JS of ours", () => {
    renderControlled();
    // Kobalte's roving focus is built on a real `<input type="radio">` group
    // (verified against the installed 0.13.13): arrows move because the
    // elements really are radios sharing a name. Asserting the element type is
    // asserting the keyboard behaviour at its actual source, since jsdom does
    // not synthesize the selection a real browser makes from an arrow key.
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    for (const el of radios) {
      expect(el.tagName).toBe("INPUT");
      expect(el.getAttribute("type")).toBe("radio");
    }
    // One name across the group is what makes them one group to the browser.
    expect(new Set(radios.map((el) => el.name)).size).toBe(1);
  });

  it("is a radiogroup named by its visible label", () => {
    renderControlled();
    expect(screen.getByRole("radiogroup", { name: "Where should it render?" })).toBeTruthy();
  });

  it("starts with nothing chosen when the value is null", () => {
    // The common case for an unanswered question. A group that arrived
    // pre-selected would answer it for the user.
    renderControlled();
    expect(screen.getAllByRole("radio").filter((el) => (el as HTMLInputElement).checked)).toEqual([]);
  });

  it("reports every pick and reflects the value it is given", () => {
    const { value } = renderControlled();

    fireEvent.click(radio("Inline"));
    expect(value()).toBe("inline");
    expect(radio("Inline").checked).toBe(true);

    fireEvent.click(radio("Modal"));
    expect(value()).toBe("modal");
    expect(radio("Modal").checked).toBe(true);
    expect(radio("Inline").checked).toBe(false);
  });

  it("picks from a press on the drawn circle, not just on the hidden input", () => {
    // The input is 1px and clipped, so every real press lands on the circle or
    // the label instead. Clicking the input directly (as the tests above do)
    // would keep passing even if the visible control were inert.
    const { container, value } = renderControlled();
    const control = container.querySelectorAll(`.${styles.control}`)[1] as HTMLElement;

    fireEvent.click(control);
    expect(value()).toBe("modal");

    fireEvent.click(screen.getByText("Inline"));
    expect(value()).toBe("inline");
  });

  it("stays where the caller puts it, so a rejected change cannot drift", () => {
    // Controlled means the DOM follows the prop, not the click. A call site
    // whose handler refuses the change must not be left showing a state its
    // store never took.
    //
    // This is the test that caught the wrapper handing Kobalte `undefined` for
    // an unanswered group: `undefined` is Kobalte's uncontrolled switch, and
    // under it this assertion failed with the radio ticked. The empty string
    // keeps it controlled. Do not "simplify" that back to `undefined`.
    const onChange = vi.fn();
    render(() => <RadioGroup options={OPTIONS} value={null} onChange={onChange} label="Pick" />);

    fireEvent.click(radio("Modal"));
    expect(onChange).toHaveBeenCalledWith("modal");
    expect(radio("Modal").checked).toBe(false);
  });

  it("announces an option's description with that option, not with the group", () => {
    // The second line is part of the choice. Announced against the group it
    // would describe every option including the ones it contradicts. It is a
    // description, not a name, so it rides `aria-describedby` and deliberately
    // does not widen the radio's accessible name to "Inline Stays in the transcript".
    const { container } = renderControlled();

    const describedBy = radio("Inline").getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe("Stays in the transcript");

    // An option with no description gets no dangling pointer.
    expect(radio("Modal").getAttribute("aria-describedby")).toBe(null);
  });

  it("names itself from aria-label when there is no visible label", () => {
    render(() => (
      <RadioGroup options={OPTIONS} value={null} onChange={() => {}} aria-label="Placement" />
    ));
    expect(screen.getByRole("radiogroup", { name: "Placement" })).toBeTruthy();
  });

  it("passes aria-describedby to the group, where a note about the whole question belongs", () => {
    // On Checkbox the same prop goes to the input, because the hint is about
    // that one box. Here the note is about the question, so it belongs to the
    // group; an option's own second line is `RadioOption.description` instead.
    render(() => (
      <>
        <RadioGroup
          options={OPTIONS}
          value={null}
          onChange={() => {}}
          label="Where should it render?"
          aria-describedby="hint"
        />
        <span id="hint">The transcript explains the question</span>
      </>
    ));
    expect(screen.getByRole("radiogroup").getAttribute("aria-describedby")).toContain("hint");
  });

  it("marks a disabled option disabled on the input itself, while the rest stay live", () => {
    // The native attribute is what actually refuses the press, so that is what
    // is asserted. `fireEvent.click` dispatches straight at the node and does
    // not honour `disabled` the way a browser's hit testing does, so a
    // "click it and expect nothing" test here would be measuring jsdom rather
    // than the wrapper. Same reasoning as the Checkbox suite's note on Space.
    const { value } = renderControlled();

    expect(radio("Sheet").disabled).toBe(true);
    expect(radio("Modal").disabled).toBe(false);

    fireEvent.click(radio("Modal"));
    expect(value()).toBe("modal");
  });

  it("ignores presses while the whole group is disabled", () => {
    const onChange = vi.fn();
    render(() => (
      <RadioGroup options={OPTIONS} value={null} onChange={onChange} label="Pick" disabled />
    ));

    fireEvent.click(radio("Modal"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });

  it("passes the axe gate laid out horizontally", async () => {
    render(() => (
      <RadioGroup
        options={OPTIONS}
        value="inline"
        onChange={() => {}}
        label="Where should it render?"
        orientation="horizontal"
      />
    ));
    await expectNoAxeViolations(document.body);
  });
});
