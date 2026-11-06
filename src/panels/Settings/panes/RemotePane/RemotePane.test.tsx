import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";

const calls: [string, unknown][] = [];
const handlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "remote_status") return Promise.resolve({ state: "off" });
    return Promise.resolve(cmd === "devices_list" || cmd === "remote_interfaces" ? [] : null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => handlers.delete(event));
  },
}));

import RemotePane from "./RemotePane";

const ask = (payload: unknown) => handlers.get("remote://pair-request")?.({ payload });

beforeEach(() => {
  cleanup();
  calls.length = 0;
  handlers.clear();
});

describe("a device asking to pair", () => {
  it("asks by name and address, with Deny focused, and sends the answer", async () => {
    render(() => <RemotePane shown={() => true} query="" />);
    await waitFor(() => expect(handlers.has("remote://pair-request")).toBe(true));
    ask({ name: "Pixel 8", addr: "100.64.0.2" });

    expect(await screen.findByText("Allow Pixel 8 from 100.64.0.2?")).toBeTruthy();
    const deny = screen.getByRole("button", { name: "Deny" });
    await waitFor(() => expect(document.activeElement).toBe(deny));

    fireEvent.click(deny);
    await waitFor(() => expect(calls).toContainEqual(["pairing_allow", { yes: false }]));
    expect(screen.queryByText("Allow Pixel 8 from 100.64.0.2?")).toBeNull();
  });
});
