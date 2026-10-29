import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";

const backend = vi.hoisted(() => ({ model: null as "moonshine" | "parakeet" | null }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
    if (cmd === "dictation_status")
      return {
        installed: backend.model !== null,
        model: backend.model,
        downloading: null,
        sizes: [
          { id: "moonshine", bytes: 66_773_687 },
          { id: "parakeet", bytes: 661_331_448 },
        ],
      };
    return undefined;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { askToDownload, dismissAsk, refresh } = await import("../../utils/dictationDownload");
const { default: DictationDownloadDialog } = await import("./DictationDownloadDialog");

beforeEach(() => {
  backend.model = null;
  dismissAsk();
  invoke.mockClear();
  render(() => <DictationDownloadDialog />);
});

describe("the dictation download dialog", () => {
  it("offers both models with Parakeet credited", async () => {
    await refresh();
    askToDownload();
    expect(await screen.findByRole("dialog", { name: "Download a dictation model" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Moonshine, 67 MB/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Parakeet, 661 MB/ })).toBeTruthy();
    expect(screen.getByText(/Parakeet by NVIDIA, CC BY 4\.0/)).toBeTruthy();
  });
});
