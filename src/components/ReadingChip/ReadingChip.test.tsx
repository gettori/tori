import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

const [reading, setReading] = createSignal<{ source: string; block?: number } | null>(null);
const stop = vi.fn(async () => setReading(null));
vi.mock("../../utils/speech", () => ({
  reading: () => reading(),
  stop: () => stop(),
  reset: async () => {},
  changeRate: vi.fn(),
}));

const { default: ReadingChip } = await import("./ReadingChip");

describe("ReadingChip", () => {
  beforeEach(() => {
    stop.mockClear();
    setReading(null);
  });

  it("shows while reading and hides once Stop is pressed", async () => {
    render(() => <ReadingChip />);
    expect(screen.queryByRole("status")).toBeNull();
    setReading({ source: "s1:t1", block: 0 });
    expect(screen.getByRole("status").textContent).toContain("Reading aloud");
    fireEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
