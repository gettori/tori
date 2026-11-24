import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, cleanup, waitFor } from "../../../../test/harness";

type ShellPath = { on: boolean; dir: string; profile: string };
const off: ShellPath = { on: false, dir: "/opt/tori/bin", profile: "/home/me/.zshrc" };
let status: () => Promise<ShellPath> = async () => off;
let calls: string[] = [];
let crashes: () => Promise<unknown> = async () => null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    if (cmd === "shell_path_status") return status();
    if (cmd === "shell_path_set") return Promise.resolve({ ...off, on: true });
    if (cmd === "crash_logs") return crashes();
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));

import AdvancedPane from "./AdvancedPane";

function hold() {
  let resolve!: (value: ShellPath) => void;
  const promise = new Promise<ShellPath>((yes) => (resolve = yes));
  return { promise, resolve };
}

const pane = () => render(() => <AdvancedPane shown={() => true} query="" />);
const statusReads = () => calls.filter((c) => c === "shell_path_status").length;
const toggle = () => screen.getByRole("button", { name: /^(Add|Remove)$/ }) as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  calls = [];
  status = async () => off;
  crashes = async () => null;
});

describe("the shell PATH row", () => {
  it("says it is checking, with Add held, until the status lands", async () => {
    const first = hold();
    status = () => first.promise;
    pane();
    expect(await screen.findByText("Checking your shell profile...")).toBeTruthy();
    expect(toggle().disabled).toBe(true);

    first.resolve(off);
    expect(await screen.findByText(/cannot run tori yet/)).toBeTruthy();
    expect(toggle().disabled).toBe(false);
  });

  it("keeps the row while it reads the status again after Add", async () => {
    pane();
    await screen.findByText(/cannot run tori yet/);

    const again = hold();
    status = () => again.promise;
    fireEvent.click(toggle());
    await waitFor(() => expect(statusReads()).toBe(2));
    expect(screen.getByText(/cannot run tori yet/)).toBeTruthy();
    expect(toggle().textContent).toBe("Add");

    again.resolve({ ...off, on: true });
    await waitFor(() => expect(toggle().textContent).toBe("Remove"));
    expect(screen.getByText("~/.zshrc")).toBeTruthy();
  });

  it("says the status could not be read, and tries again", async () => {
    status = () => Promise.reject("no profile");
    pane();
    expect(await screen.findByText(/no profile/)).toBeTruthy();
    expect(toggle().disabled).toBe(true);

    status = async () => off;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText(/cannot run tori yet/)).toBeTruthy();
  });
});

describe("the crash logs row", () => {
  const reveal = () => screen.getByRole("button", { name: "Reveal" }) as HTMLButtonElement;
  const crash = { path: "/logs/crash-1.txt", at: Date.now() - 60_000, headline: "panic in pty reader" };

  it("says it is looking, with Reveal held, until the files land", async () => {
    let land!: (value: unknown) => void;
    crashes = () => new Promise((yes) => (land = yes));
    pane();
    expect(await screen.findByText("Looking for crash files...")).toBeTruthy();
    expect(reveal().disabled).toBe(true);

    land({ version: "26.1100.0", files: [crash] });
    expect(await screen.findByText("panic in pty reader")).toBeTruthy();
    expect(reveal().disabled).toBe(false);
  });

  it("says there are none when the folder is empty", async () => {
    crashes = async () => ({ version: "26.1100.0", files: [] });
    pane();
    expect(await screen.findByText(/No crash files\./)).toBeTruthy();
  });

  it("says the files could not be read instead of calling them none, and tries again", async () => {
    crashes = () => Promise.reject("permission denied");
    pane();
    expect(await screen.findByText(/The crash files could not be read: permission denied/)).toBeTruthy();
    expect(screen.queryByText(/No crash files\./)).toBeNull();

    crashes = async () => ({ version: "26.1100.0", files: [crash] });
    fireEvent.click(screen.getAllByText("Try again")[0]);
    expect(await screen.findByText("panic in pty reader")).toBeTruthy();
  });
});
