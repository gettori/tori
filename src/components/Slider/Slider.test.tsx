import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "../../test/harness";
import { createSignal } from "solid-js";
import Slider from "./Slider";
import { expectNoAxeViolations } from "../../test/axe";

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

  it("follows a drag past the end and back, and presses on the track", () => {
    const { value } = renderControlled();
    const thumb = screen.getByRole("slider");
    const track = thumb.parentElement!;
    // jsdom lays nothing out and has no pointer capture.
    track.getBoundingClientRect = () => new DOMRect(0, 0, 110, 4);
    const captured = new Set<number>();
    for (const el of [track, thumb]) {
      el.setPointerCapture = (id) => void captured.add(id);
      el.hasPointerCapture = (id) => captured.has(id);
      el.releasePointerCapture = (id) => void captured.delete(id);
    }
    const pointer = (type: string, el: HTMLElement, clientX: number) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }));

    pointer("pointerdown", thumb, 30);
    expect(document.activeElement).toBe(thumb);
    pointer("pointermove", thumb, 60);
    expect(value()).toBeCloseTo(1.15, 5);
    pointer("pointermove", thumb, 500);
    expect(value()).toBeCloseTo(1.4, 5);
    pointer("pointermove", thumb, 60);
    expect(value()).toBeCloseTo(1.15, 5);
    pointer("pointerup", thumb, 60);
    pointer("pointermove", thumb, 90);
    expect(value()).toBeCloseTo(1.15, 5);

    pointer("pointerdown", track, 20);
    expect(value()).toBeCloseTo(0.95, 5);
    pointer("pointerup", track, 20);
  });

  it("passes the axe gate", async () => {
    renderControlled();
    await expectNoAxeViolations(document.body);
  });
});
