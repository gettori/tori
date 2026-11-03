import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Inspection } from "./AttachFolderDialog";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  found: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    if (cmd === "inspect_folder") return Promise.resolve(bridge.found);
    if (cmd === "attach_folder") return Promise.resolve({ path: args.path });
    return Promise.resolve(null);
  },
}));

const { default: AttachFolderDialog } = await import("./AttachFolderDialog");

const PLAIN: Inspection = { path: "/Users/me/Documents/thesis", name: "thesis", layout: { kind: "plain" } };
const CLONE: Inspection = {
  path: "/Users/me/clients/acme-site",
  name: "acme-site",
  layout: { kind: "clone", branch: "main", branches: 4, remote: "git@github.com:acme/site.git", worktrees: [] },
};
const BARE: Inspection = {
  path: "/Users/me/src/lib.git",
  name: "lib",
  layout: {
    kind: "bare",
    worktrees: [
      { branch: "main", path: "/Users/me/src/lib-main" },
      { branch: "fix/leak", path: "/Volumes/Work/lib-leak" },
    ],
  },
};

function open(found: Inspection) {
  bridge.found = found;
  const done = vi.fn();
  render(() => (
    <AttachFolderDialog
      path={found.path}
      home="/Users/me"
      onChange={() => Promise.resolve(null)}
      onDone={done}
      onCancel={() => {}}
    />
  ));
  return done;
}

describe("AttachFolderDialog", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
  });

  it("reads a plain folder as one with nothing to branch", async () => {
    open(PLAIN);
    expect(await screen.findByText("Plain folder")).toBeTruthy();
    expect(screen.getByText("~/Documents/thesis")).toBeTruthy();
  });

  it("reads a clone's branch, branch count and remote", async () => {
    open(CLONE);
    expect(await screen.findByText("Git repository on main")).toBeTruthy();
    expect(screen.getByText(/A clone with four local branches/)).toBeTruthy();
    expect(screen.getByText("github.com/acme/site")).toBeTruthy();
    expect(screen.getByText("none besides main")).toBeTruthy();
  });

  it("lists a bare clone's worktrees wherever they sit", async () => {
    open(BARE);
    expect(await screen.findByText("Bare repository with two worktrees")).toBeTruthy();
    expect(screen.getByText("fix/leak")).toBeTruthy();
    expect(screen.getByText("/Volumes/Work/lib-leak")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("lib");
  });

  it("attaches under the name typed", async () => {
    const done = open(CLONE);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("acme-site"));
    fireEvent.input(name, { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(CLONE.path, undefined));
    expect(bridge.calls.find((c) => c.cmd === "attach_folder")?.args).toEqual({ path: CLONE.path, name: "acme" });
  });
});
