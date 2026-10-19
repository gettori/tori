import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";

let status = {
  installed: true,
  connected: true,
  update: null as "extension" | "tori" | null,
  store: "https://chromewebstore.google.com/detail/the-id",
  browsers: [{ name: "Chrome", installed: true }],
};
const calls: [string, unknown][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return Promise.resolve(cmd === "browser_status" ? status : null);
  },
}));

import BrowserPane from "./BrowserPane";

const pane = () => render(() => <BrowserPane shown={() => true} query="" />);

beforeEach(() => {
  cleanup();
  calls.length = 0;
  status = { ...status, connected: true, update: null };
});

describe("the Browser settings pane", () => {
  it("opens the store page in the default browser", async () => {
    pane();
    await screen.findByText("Connected", { selector: "[role=status]" });
    fireEvent.click(screen.getByText("Get the extension"));
    await waitFor(() => expect(calls).toContainEqual(["plugin:opener|open_url", { url: status.store }]));
  });

  it("names the side to update over Connected", async () => {
    status = { ...status, update: "extension" };
    pane();
    expect(await screen.findByText("Update the extension")).toBeTruthy();
    cleanup();

    status = { ...status, update: "tori" };
    pane();
    expect(await screen.findByText("Update Tori")).toBeTruthy();
    expect(screen.queryByText("Connected", { selector: "[role=status]" })).toBeNull();
  });
});
