import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, cleanup, fireEvent } from "@solidjs/testing-library";

let calls: [string, unknown][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return Promise.resolve(null);
  },
}));

const { default: PackControls } = await import("./PackControls");

beforeEach(() => {
  cleanup();
  calls = [];
});

describe("PackControls", () => {
  it("refuses to update a pack its card says is in use", () => {
    const toasts: string[] = [];
    const toast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener("tori:toast", toast);
    render(() => (
      <PackControls
        kind="agents"
        id="claude"
        label="Claude Code"
        provenance={{ source: "catalog", updateAvailable: true, catalogConflict: false }}
        blocked={() => "Close the tabs using claude first."}
      />
    ));

    fireEvent.click(screen.getByLabelText("Update the Claude Code pack"));
    window.removeEventListener("tori:toast", toast);

    expect(toasts).toEqual(["Close the tabs using claude first."]);
    expect(calls.map(([cmd]) => cmd)).not.toContain("packs_update");
  });
});
