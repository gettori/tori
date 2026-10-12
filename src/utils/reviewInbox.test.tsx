import { describe, it, expect, vi } from "vite-plus/test";

const handlers = new Map<string, () => void>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    handlers.set(name, handler);
    return () => {};
  }),
}));

const { invoke } = await import("@tauri-apps/api/core");
const { watchInbox } = await import("./reviewInbox");

describe("the desktop Inbox", () => {
  it("re-pulls when the radar moves", async () => {
    vi.useFakeTimers();
    watchInbox();
    await vi.waitFor(() => expect(handlers.has("radar://changed")).toBe(true));
    vi.mocked(invoke).mockClear();

    handlers.get("radar://changed")!();
    vi.advanceTimersByTime(2000);

    expect(invoke).toHaveBeenCalledWith("review_inbox");
    vi.useRealTimers();
  });
});
