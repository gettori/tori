import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "../../../test/harness";

const bridge = vi.hoisted(() => ({
  pkg: "" as string,
  dirReads: 0,
  dir: null as (() => Promise<unknown>) | null,
  listeners: {} as Record<string, ((e: { payload: unknown }) => void)[]>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "fs_read_dir":
        bridge.dirReads += 1;
        return bridge.dir ? bridge.dir() : Promise.resolve([{ name: "package.json" }]);
      case "fs_read_file":
        return Promise.resolve(bridge.pkg);
      case "list_project_files":
      case "web_setup":
      case "pty_busy_ids":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (bridge.listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
}));

const { default: ScriptsSection } = await import("./ScriptsSection");

const scripts = (map: Record<string, string>) => JSON.stringify({ scripts: map });

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(() => {
  bridge.pkg = scripts({ dev: "vite" });
  bridge.dir = null;
  bridge.dirReads = 0;
  bridge.listeners = {};
});

describe("the Scripts section", () => {
  it("says it is reading until the scripts land, then lists them", async () => {
    const read = hold();
    bridge.dir = () => read.promise;
    render(() => <ScriptsSection root="/repo" />);
    expect(await screen.findByText("Reading the scripts...")).toBeTruthy();
    expect(screen.queryByText(/No scripts here/)).toBeNull();

    read.resolve([{ name: "package.json" }]);
    expect(await screen.findByText("dev")).toBeTruthy();
    expect(screen.queryByText("Reading the scripts...")).toBeNull();
  });

  it("keeps the scripts up while an edited package.json is read again", async () => {
    render(() => <ScriptsSection root="/repo" />);
    await screen.findByText("dev");
    await waitFor(() => expect(bridge.listeners["fs://changed"]?.length).toBe(1));

    const again = hold();
    bridge.dir = () => again.promise;
    bridge.pkg = scripts({ dev: "vite", test: "vitest" });
    bridge.listeners["fs://changed"][0]({ payload: { root: "/repo", paths: ["/repo/package.json"] } });
    await waitFor(() => expect(bridge.dirReads).toBe(2));
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.queryByText("Reading the scripts...")).toBeNull();

    again.resolve([{ name: "package.json" }]);
    expect(await screen.findByText("test")).toBeTruthy();
  });

  it("says why the folder could not be read instead of claiming there are no scripts, and tries again", async () => {
    bridge.dir = () => Promise.reject("permission denied");
    render(() => <ScriptsSection root="/repo" />);
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(screen.queryByText(/No scripts here/)).toBeNull();

    bridge.dir = null;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("dev")).toBeTruthy();
  });
});
