import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import Checkbox from "./Checkbox";
import styles from "./Checkbox.module.css";
import { expectNoAxeViolations } from "../../test/axe";

// What this suite holds is the contract the migrated call sites depend on: a
// real native checkbox in the accessibility tree, a controlled value, and the
// describedby pass-through. The box and tick are CSS, which jsdom has no
// opinion about, so nothing here asserts on appearance.
function renderControlled(over: Partial<Parameters<typeof Checkbox>[0]> = {}) {
  const [checked, setChecked] = createSignal(false);
  const r = render(() => (
    <Checkbox checked={checked()} onChange={setChecked} label="Include untracked" {...over} />
  ));
  return { ...r, checked };
}

const box = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("Checkbox", () => {
  it("renders a native checkbox input, so Space toggles it without any JS of ours", () => {
    renderControlled();
    // Kobalte has no Space handler on this primitive (verified against the
    // installed 0.13.13): the key works because the element really is an
    // `<input type="checkbox">`. Asserting the element type is asserting the
    // keyboard behaviour at its actual source - jsdom does not synthesize the
    // click a real browser generates from Space, so a keyDown test here would
    // pass or fail on jsdom's fidelity rather than on the wrapper.
    expect(box().tagName).toBe("INPUT");
    expect(box().getAttribute("type")).toBe("checkbox");
  });

  it("is labelled by its visible label", () => {
    renderControlled();
    expect(screen.getByRole("checkbox", { name: "Include untracked" })).toBeTruthy();
  });

  it("reports every toggle and reflects the value it is given", () => {
    const { checked } = renderControlled();

    fireEvent.click(box());
    expect(checked()).toBe(true);
    expect(box().checked).toBe(true);

    fireEvent.click(box());
    expect(checked()).toBe(false);
    expect(box().checked).toBe(false);
  });

  it("toggles from a press on the drawn box, not just on the hidden input", () => {
    // The input is 1px and clipped, so every real press lands on the box or the
    // label instead. Clicking the input directly (as the tests above do) would
    // keep passing even if the visible control were inert.
    const { container } = renderControlled();
    const control = container.querySelector(`.${styles.control}`) as HTMLElement;

    fireEvent.click(control);
    expect(box().checked).toBe(true);

    fireEvent.click(screen.getByText("Include untracked"));
    expect(box().checked).toBe(false);
  });

  it("stays where the caller puts it, so a rejected change cannot drift", () => {
    // Controlled means the DOM follows the prop, not the click. A call site
    // whose handler refuses the change (a failed write, a guard) must not be
    // left showing a state its store never took.
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} onChange={onChange} label="Amend" />);

    fireEvent.click(box());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(box().checked).toBe(false);
  });

  it("passes aria-describedby to the input, where the hint has to be announced", () => {
    render(() => (
      <>
        <Checkbox checked={false} onChange={() => {}} label="Amend" aria-describedby="hint" />
        <span id="hint">Rewrites the last commit</span>
      </>
    ));
    expect(box().getAttribute("aria-describedby")).toContain("hint");
  });

  it("names itself from aria-label when there is no visible label", () => {
    render(() => <Checkbox checked={false} onChange={() => {}} aria-label="Show reads" />);
    expect(screen.getByRole("checkbox", { name: "Show reads" })).toBeTruthy();
  });

  it("ignores presses while disabled", () => {
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} onChange={onChange} label="Amend" disabled />);

    fireEvent.click(box());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });
});
