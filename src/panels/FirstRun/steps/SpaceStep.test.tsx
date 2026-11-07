import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

let saved: { sidebar: { lanes: { default: { enabled: boolean } } } } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { settings: typeof saved }) => {
    if (cmd === "set_settings") {
      saved = args!.settings;
      return Promise.resolve(saved);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: SpaceStep } = await import("./SpaceStep");

describe("first run's space step", () => {
  it("turns PR lanes on for every Space that has not chosen for itself", async () => {
    render(() => (
      <SpaceStep
        root="/w"
        spaces={[{ name: "work", path: "/w/work", projects: [] } as never]}
        home="/home"
        mode="pick"
        onMode={() => {}}
        selected="work"
        onSelect={() => {}}
        name=""
        onName={() => {}}
        onSubmit={() => {}}
      />
    ));
    const lanes = screen.getByLabelText("PR lanes") as HTMLInputElement;
    expect(lanes.checked).toBe(false);
    fireEvent.click(lanes);
    await waitFor(() => expect(saved?.sidebar.lanes.default.enabled).toBe(true));
    expect(lanes.checked).toBe(true);
  });
});
