import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../../../test/menus";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { settings: unknown }) => {
    if (cmd === "set_settings") return Promise.resolve(args!.settings);
    if (cmd === "get_config")
      return Promise.resolve({
        spaces: [
          { name: "work", projects: [] },
          { name: "personal", projects: [] },
        ],
      });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: SidebarPane } = await import("./SidebarPane");
const { settings, resetLanes } = await import("../../settingsStore");

async function scopeTo(label: string) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  pointerClick(screen.getByLabelText("Lanes for"));
  await screen.findByRole("listbox");
  pointerClick(await screen.findByRole("option", { name: label }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("lane setup in the Sidebar pane", () => {
  beforeEach(async () => {
    cleanup();
    for (const s of ["work", "personal"]) await resetLanes(s);
    await resetLanes(null);
  });

  it("changes only the Space it is set to, and Reset gives that Space back to Default", async () => {
    render(() => <SidebarPane shown={() => true} query="" />);
    await scopeTo("work");
    fireEvent.click(screen.getByLabelText("PR lanes"));
    await waitFor(() => expect(settings.sidebar.lanes.spaces.work?.enabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(settings.sidebar.lanes.spaces.work?.lit).toContain("draft"));
    expect(settings.sidebar.lanes.spaces.personal).toBeUndefined();
    expect(settings.sidebar.lanes.default.enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(settings.sidebar.lanes.spaces.work).toBeUndefined());
    expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
