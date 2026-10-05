import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import CheckboxGroup, { type CheckboxOption } from "./CheckboxGroup";
import { expectNoAxeViolations } from "../../test/axe";

// The contract a consumer depends on: a named group, real native checkboxes,
// an array the caller owns, and an order that follows the options rather than
// the clicks. The boxes' own behaviour is Checkbox's and is tested there.

const OPTIONS: CheckboxOption[] = [
  { value: "check", label: "Add check 9", description: "Covers the title copy" },
  { value: "comment", label: "Comment the coupling" },
  { value: "leave", label: "Leave all three", disabled: true },
];

function renderControlled(over: Partial<Parameters<typeof CheckboxGroup>[0]> = {}) {
  const [value, setValue] = createSignal<string[]>([]);
  const r = render(() => (
    <CheckboxGroup options={OPTIONS} value={value()} onChange={setValue} label="Which should I address?" {...over} />
  ));
  return { ...r, value };
}

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("CheckboxGroup", () => {
  it("is a group named by its visible label", () => {
    renderControlled();
    expect(screen.getByRole("group", { name: "Which should I address?" })).toBeTruthy();
  });

  it("renders one native checkbox per option", () => {
    renderControlled();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    for (const el of boxes) expect(el.getAttribute("type")).toBe("checkbox");
  });

  it("starts with nothing chosen and accumulates picks", () => {
    const { value } = renderControlled();
    expect(value()).toEqual([]);

    fireEvent.click(box("Add check 9"));
    expect(value()).toEqual(["check"]);

    fireEvent.click(box("Comment the coupling"));
    expect(value()).toEqual(["check", "comment"]);
  });

  it("reports the options' order, not the click order", () => {
    // The synthesized answer string joins these picks, so an array that
    // followed click order would make the same two answers read differently
    // depending on which box the user happened to hit first.
    const { value } = renderControlled();

    fireEvent.click(box("Comment the coupling"));
    fireEvent.click(box("Add check 9"));

    expect(value()).toEqual(["check", "comment"]);
  });

  it("removes a pick without disturbing the rest", () => {
    const { value } = renderControlled();

    fireEvent.click(box("Add check 9"));
    fireEvent.click(box("Comment the coupling"));
    fireEvent.click(box("Add check 9"));

    expect(value()).toEqual(["comment"]);
  });

  it("stays where the caller puts it, so a rejected change cannot drift", () => {
    const onChange = vi.fn();
    render(() => <CheckboxGroup options={OPTIONS} value={[]} onChange={onChange} label="Pick" />);

    fireEvent.click(box("Add check 9"));
    expect(onChange).toHaveBeenCalledWith(["check"]);
    expect(box("Add check 9").checked).toBe(false);
  });

  it("announces an option's description with that option", () => {
    const { container } = renderControlled();

    const describedBy = box("Add check 9").getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${describedBy}`)?.textContent).toBe("Covers the title copy");

    expect(box("Comment the coupling").getAttribute("aria-describedby")).toBe(null);
  });

  it("names itself from aria-label when there is no visible label", () => {
    render(() => <CheckboxGroup options={OPTIONS} value={[]} onChange={() => {}} aria-label="Fixes" />);
    expect(screen.getByRole("group", { name: "Fixes" })).toBeTruthy();
  });

  it("disables one option without disabling the group", () => {
    renderControlled();
    expect(box("Leave all three").disabled).toBe(true);
    expect(box("Add check 9").disabled).toBe(false);
  });

  it("disables every box when the group is disabled", () => {
    renderControlled({ disabled: true });
    for (const el of screen.getAllByRole("checkbox")) {
      expect((el as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });
});
