// The Remote section: a switch Rust owns, so it writes through `remote_set`
// rather than `set_settings`, and the status line shows what Rust answered.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadSettings } from "./settingsStore";

beforeEach(async () => {
  // What `remote_set` saved is what the next `get_settings` reads, as on disk.
  let stored = { enabled: false, address: "192.168.1.20", port: 47821 };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { remote?: typeof stored }) => {
    if (cmd === "remote_interfaces") return [{ name: "en0", address: "192.168.1.20", kind: "lan" }];
    if (cmd === "remote_status") return { state: "off" };
    if (cmd === "remote_set") {
      stored = args.remote!;
      return { state: "listening", url: "ws://192.168.1.20:47821" };
    }
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, remote: stored };
    return null;
  });
  await loadSettings();
});

const openRemote = () => {
  render(() => <Settings onClose={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Remote/ }));
};

describe("the Remote settings section", () => {
  it("turns remote access on through remote_set and shows where it listens", async () => {
    openRemote();
    fireEvent.click(screen.getByRole("switch", { name: "Remote access" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_set", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "remote_set")!;
    expect(args).toEqual({ remote: { enabled: true, address: "192.168.1.20", port: 47821 } });
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
    expect(await screen.findByText("Listening on ws://192.168.1.20:47821")).toBeTruthy();
    expect(invoke.mock.calls.filter(([c]) => c === "remote_set"), "one click, one write").toHaveLength(1);
  });

  it("passes the accessibility gate", async () => {
    openRemote();
    await screen.findByText("Off");
    await expectNoAxeViolations(document.body);
  });
});
