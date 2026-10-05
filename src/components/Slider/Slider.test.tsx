import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import Slider from "./Slider";
import { expectNoAxeViolations } from "../../test/axe";

// Pointer dragging is not testable here and deliberately untested: Kobalte maps
// a pointer position onto a value through getBoundingClientRect, and jsdom
// reports a zero-sized track, so every drag would land on the same value. The
// keyboard path runs through Kobalte's own onKeyDown (verified present in
// 0.13.13's slider chunk) and exercises the same value pipeline, so that is
// what this suite drives.
function renderControlled(over: Partial<Parameters<typeof Slider>[0]> = {}) {
  const [value, setValue] = createSignal(1);
  const r = render(() => (
    <Slider value={value()} onChange={setValue} min={0.85} max={1.4} step={0.05} label="UI scale" {...over} />
  ));
  return { ...r, value };
}

describe("Slider", () => {
  it("exposes a single thumb carrying the value", () => {
    renderControlled();
    const thumb = screen.getByRole("slider");
    expect(thumb.getAttribute("aria-valuenow")).toBe("1");
    expect(thumb.getAttribute("aria-valuemin")).toBe("0.85");
    expect(thumb.getAttribute("aria-valuemax")).toBe("1.4");
  });

  it("is labelled by its visible label", () => {
    renderControlled();
    expect(screen.getByRole("slider", { name: "UI scale" })).toBeTruthy();
  });

  it("moves by one step per arrow key, in both directions", () => {
    const { value } = renderControlled();
    const thumb = screen.getByRole("slider");

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(value()).toBeCloseTo(1.05, 5);

    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    expect(value()).toBeCloseTo(1, 5);
  });

  it("reports each intermediate value as it moves, which is what a live preview needs", () => {
    // The ui-scale control applies every value it is handed. One notification
    // per step (rather than one on release) is the contract that keeps the
    // preview continuous.
    const onChange = vi.fn();
    const [value, setValue] = createSignal(1);
    render(() => (
      <Slider
        value={value()}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        min={0.85}
        max={1.4}
        step={0.05}
        label="UI scale"
      />
    ));
    const thumb = screen.getByRole("slider");

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls.map(([v]) => Number(v.toFixed(2)))).toEqual([1.05, 1.1, 1.15]);
  });

  it("clamps at both ends rather than running past them", () => {
    // Driven with the arrows rather than Home/End: those two route through the
    // root's own handlers rather than the thumb's, and the arrows exercise the
    // clamp on the same path a user actually nudges the value along.
    const { value } = renderControlled();
    const thumb = screen.getByRole("slider");

    // 1 -> 1.4 is eight steps; the extra presses are the point.
    for (let i = 0; i < 12; i++) fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(value()).toBeCloseTo(1.4, 5);

    // 1.4 -> 0.85 is eleven steps, likewise overshot on purpose.
    for (let i = 0; i < 15; i++) fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    expect(value()).toBeCloseTo(0.85, 5);
  });

  it("ignores the keyboard while disabled", () => {
    const onChange = vi.fn();
    render(() => <Slider value={1} onChange={onChange} min={0.85} max={1.4} step={0.05} label="UI scale" disabled />);

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });
});
