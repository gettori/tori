import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import Switch from "./Switch";
import styles from "./Switch.module.css";
import { expectNoAxeViolations } from "../../test/axe";

// The Settings suites query these by role after the migration, so the two facts
// that matter most here are that the element is a native checkbox input (Space
// works for free) *and* that it announces as a switch.
function renderControlled(over: Partial<Parameters<typeof Switch>[0]> = {}) {
  const [checked, setChecked] = createSignal(false);
  const r = render(() => (
    <Switch checked={checked()} onChange={setChecked} label="Stream responses" {...over} />
  ));
  return { ...r, checked };
}

const toggle = () => screen.getByRole("switch") as HTMLInputElement;

describe("Switch", () => {
  it("renders a native checkbox input carrying role=switch", () => {
    renderControlled();
    // Verified against the installed Kobalte 0.13.13: the primitive sets
    // role="switch" on a real `<input type="checkbox">`. That pairing is the
    // whole reason Space toggles it with no JS of ours while screen readers
    // still announce a switch, and it is what lets the migrated Settings tests
    // keep querying an input.
    expect(toggle().tagName).toBe("INPUT");
    expect(toggle().getAttribute("type")).toBe("checkbox");
  });

  it("is labelled by its visible label", () => {
    renderControlled();
    expect(screen.getByRole("switch", { name: "Stream responses" })).toBeTruthy();
  });

  it("reports every flip and reflects the value it is given", () => {
    const { checked } = renderControlled();

    fireEvent.click(toggle());
    expect(checked()).toBe(true);
    expect(toggle().checked).toBe(true);

    fireEvent.click(toggle());
    expect(checked()).toBe(false);
    expect(toggle().checked).toBe(false);
  });

  it("toggles from a press on the drawn track, not just on the hidden input", () => {
    // The input is 1px and clipped, so every real press lands on the track or
    // the label instead.
    const { container } = renderControlled();
    const control = container.querySelector(`.${styles.control}`) as HTMLElement;

    fireEvent.click(control);
    expect(toggle().checked).toBe(true);

    fireEvent.click(screen.getByText("Stream responses"));
    expect(toggle().checked).toBe(false);
  });

  it("stays where the caller puts it, so a refused write cannot drift", () => {
    // The instant-effect settings write through a store that can reject or
    // reshape the value; the control must show the store's answer, not the
    // click.
    const onChange = vi.fn();
    render(() => <Switch checked={false} onChange={onChange} label="Git blame" />);

    fireEvent.click(toggle());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle().checked).toBe(false);
  });

  it("passes aria-describedby to the input, where the hint has to be announced", () => {
    render(() => (
      <>
        <Switch checked={false} onChange={() => {}} label="Cumulative" aria-describedby="hint" />
        <span id="hint">Compares against the first checkpoint</span>
      </>
    ));
    expect(toggle().getAttribute("aria-describedby")).toContain("hint");
  });

  it("names itself from aria-label when there is no visible label", () => {
    render(() => <Switch checked={false} onChange={() => {}} aria-label="Show reads" />);
    expect(screen.getByRole("switch", { name: "Show reads" })).toBeTruthy();
  });

  it("ignores presses while disabled", () => {
    const onChange = vi.fn();
    render(() => <Switch checked={false} onChange={onChange} label="Git blame" disabled />);

    fireEvent.click(toggle());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });
});
