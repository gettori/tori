import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "../../test/harness";

const bridge = vi.hoisted(() => ({
  head: "aaa",
  log: null as (() => Promise<unknown>) | null,
  rows: [] as unknown[],
  logReads: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_head_sha":
        return Promise.resolve(bridge.head);
      case "git_base_offset":
        return Promise.resolve(0);
      case "git_log":
        bridge.logReads += 1;
        return bridge.log ? bridge.log() : Promise.resolve(bridge.rows);
      default:
        return Promise.resolve(null);
    }
  },
}));

const { default: GraphSection } = await import("./GraphSection");
const { enterRoots, refreshMeta } = await import("../../utils/gitActions");

const ROOT = "/repo";
const commit = (sha: string, subject: string) => ({
  sha,
  short: sha.slice(0, 7),
  subject,
  author: "Sk Arif",
  relative_date: "now",
  committed_at: 1_700_000_000,
  refs: [],
  parents: [],
  unpushed: false,
  off_base: false,
});

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(async () => {
  enterRoots([ROOT]);
  bridge.head = "aaa";
  bridge.log = null;
  bridge.rows = [commit("a".repeat(40), "first commit")];
  bridge.logReads = 0;
  await refreshMeta(ROOT);
});

describe("the history section", () => {
  it("says it is reading the history instead of claiming there are no commits, then lists them", async () => {
    const read = hold();
    bridge.log = () => read.promise;
    render(() => <GraphSection root={ROOT} />);
    expect(await screen.findByText("Reading the history...")).toBeTruthy();
    expect(screen.queryByText("No commits yet.")).toBeNull();

    read.resolve(bridge.rows);
    expect(await screen.findByText("first commit")).toBeTruthy();
    expect(screen.queryByText("Reading the history...")).toBeNull();
  });

  it("keeps the list up while a moved HEAD reads the log again", async () => {
    render(() => <GraphSection root={ROOT} />);
    await screen.findByText("first commit");

    const again = hold();
    bridge.log = () => again.promise;
    bridge.head = "bbb";
    await refreshMeta(ROOT);
    await waitFor(() => expect(bridge.logReads).toBe(2));
    expect(screen.getByText("first commit")).toBeTruthy();
    expect(screen.queryByText("Reading the history...")).toBeNull();

    again.resolve([commit("b".repeat(40), "second commit"), ...bridge.rows]);
    expect(await screen.findByText("second commit")).toBeTruthy();
  });

  it("says why the log could not be read, and tries again", async () => {
    bridge.log = () => Promise.reject("not a git repository");
    render(() => <GraphSection root={ROOT} />);
    expect(await screen.findByText(/not a git repository/)).toBeTruthy();
    expect(screen.queryByText("No commits yet.")).toBeNull();

    bridge.log = null;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("first commit")).toBeTruthy();
  });
});
