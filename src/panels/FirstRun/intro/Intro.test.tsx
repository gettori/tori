import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import Intro, { SLIDES } from "./Intro";
import { installResizeObserver } from "../../Editor/__fixtures__/editorAgent";

installResizeObserver();

describe("Intro", () => {
  it("walks all eight slides with the arrow keys and finishes on the last", () => {
    const onDone = vi.fn();
    const [slide, setSlide] = createSignal(0);
    render(() => <Intro slide={slide()} onSlide={setSlide} onDone={onDone} />);
    const panel = screen.getByRole("dialog", { name: "Tori" });

    expect(SLIDES[2].title).toBe("One branch across several repos");
    for (let i = 0; i < SLIDES.length; i++) {
      expect(screen.getByText(`${String(i + 1).padStart(2, "0")} / 08`)).toBeTruthy();
      fireEvent.keyDown(panel, { key: "ArrowRight" });
    }
    expect(slide()).toBe(7);
    expect(onDone).toHaveBeenCalledTimes(1);

    for (let i = 0; i < SLIDES.length; i++) fireEvent.keyDown(panel, { key: "ArrowLeft" });
    expect(slide()).toBe(0);
  });
});
