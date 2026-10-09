import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Catalog } from "../../../utils/packs";
import type { OpenTerm } from "../../Terminal/terminalTabStore";

let calls: [string, unknown][] = [];
const catalog: Catalog = {
  rows: [
    {
      pack: {
        kind: "agents",
        id: "claude",
        role: null,
        label: "Claude Code",
        description: null,
        contributor: null,
        license: null,
        verified_against: null,
        verified_on: null,
        platforms: [],
      },
      installed: true,
      bundled: true,
      updateAvailable: true,
      customFile: false,
    },
  ],
  generatedAt: null,
  stale: false,
  problem: null,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "packs_catalog") return Promise.resolve(catalog);
    return Promise.resolve(null);
  },
}));

const { default: AddPack } = await import("./AddPack");
const { setOpen } = await import("../../Terminal/terminalTabStore");

beforeEach(() => {
  cleanup();
  calls = [];
  setOpen([]);
});

describe("AddPack", () => {
  it("refuses to update an agent a chat pane is using", async () => {
    setOpen([{ id: "t1", kind: "chat", program: "claude", sessionId: "s1" } as OpenTerm]);
    const toasts: string[] = [];
    const toast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener("tori:toast", toast);
    render(() => <AddPack kind="agents" label="Add an agent" />);

    fireEvent.click(screen.getByText("Add an agent"));
    fireEvent.click(await waitFor(() => screen.getByText("Update")));
    window.removeEventListener("tori:toast", toast);

    expect(toasts).toEqual(["Close the tabs using claude first."]);
    expect(calls.map(([cmd]) => cmd)).not.toContain("packs_update");
  });
});
