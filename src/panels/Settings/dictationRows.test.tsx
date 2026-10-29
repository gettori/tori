import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));

import ChatPane from "./panes/ChatPane/ChatPane";
import { loadWorkspaceSettings } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";

const dictation: { model: "moonshine" | "parakeet" | null } = { model: "moonshine" };

beforeEach(async () => {
  dictation.model = "moonshine";
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "dictation_status")
      return {
        installed: dictation.model !== null,
        model: dictation.model,
        downloading: null,
        sizes: [
          { id: "moonshine", bytes: 66_773_687 },
          { id: "parakeet", bytes: 661_331_448 },
        ],
      };
    if (cmd === "dictation_delete") dictation.model = null;
    return unstubbed(cmd);
  });
  await loadWorkspaceSettings(null);
});

const paneProps = { shown: (id: string) => id === "dictation-model", query: "" };
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Dictation settings group", () => {
  it("shows the downloaded model with Change and Delete, and offers Download once it is gone", async () => {
    render(() => <ChatPane {...paneProps} />);
    expect(await screen.findByText("Moonshine")).toBeTruthy();
    expect(screen.getByText("67 MB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change the dictation model" })).toBeTruthy();
    expect(screen.queryByText(/Parakeet by NVIDIA/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete the dictation model" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Delete the dictation model?")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("dictation_delete");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await macrotask();
    expect(invoke).toHaveBeenCalledWith("dictation_delete");
    expect(await screen.findByText("Not downloaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change the dictation model" })).toBeNull();
  });

  it("credits NVIDIA while Parakeet is the downloaded model", async () => {
    dictation.model = "parakeet";
    render(() => <ChatPane {...paneProps} />);
    expect(await screen.findByText("Parakeet")).toBeTruthy();
    expect(screen.getByText("661 MB")).toBeTruthy();
    expect(screen.getByText(/Parakeet by NVIDIA, CC BY 4\.0\./)).toBeTruthy();
  });
});
