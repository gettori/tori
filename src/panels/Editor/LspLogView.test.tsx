import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "../../test/harness";
import LspLogView from "./LspLogView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

describe("a language server's log tab", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is reading until the log lands, then shows it", async () => {
    const read = hold();
    invoked.mockImplementation(async (command) => (command === "lsp_log" ? read.promise : undefined));
    render(() => <LspLogView root="/repo" serverId="tsserver" />);
    expect(await screen.findByText("Reading the log...")).toBeTruthy();
    expect(screen.queryByText("This server has written nothing to stderr.")).toBeNull();

    read.resolve("panic at line 3");
    expect(await screen.findByText("panic at line 3")).toBeTruthy();
    expect(screen.queryByText("Reading the log...")).toBeNull();
  });

  it("says an empty log is empty", async () => {
    invoked.mockImplementation(async (command) => (command === "lsp_log" ? "" : undefined));
    render(() => <LspLogView root="/repo" serverId="tsserver" />);
    expect(await screen.findByText("This server has written nothing to stderr.")).toBeTruthy();
  });

  it("keeps the shown log while another server's log is read", async () => {
    const second = hold();
    invoked.mockImplementation(async (command, args) => {
      if (command !== "lsp_log") return undefined;
      const { handle } = args as { handle: { serverId: string } };
      return handle.serverId === "tsserver" ? "first log" : second.promise;
    });
    const [server, setServer] = createSignal("tsserver");
    render(() => <LspLogView root="/repo" serverId={server()} />);
    await screen.findByText("first log");

    setServer("eslint");
    await waitFor(() => expect(invoked).toHaveBeenCalledTimes(2));
    expect(screen.getByText("first log")).toBeTruthy();
    expect(screen.queryByText("Reading the log...")).toBeNull();

    second.resolve("second log");
    expect(await screen.findByText("second log")).toBeTruthy();
  });

  it("says the log could not be read instead of calling it empty, and tries again", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "lsp_log") throw "no such server";
    });
    render(() => <LspLogView root="/repo" serverId="tsserver" />);
    expect(await screen.findByText(/The log could not be read: no such server/)).toBeTruthy();
    expect(screen.queryByText("This server has written nothing to stderr.")).toBeNull();

    invoked.mockImplementation(async (command) => (command === "lsp_log" ? "back again" : undefined));
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("back again")).toBeTruthy();
  });
});
