import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// The view over the backend's real command names and argument shapes. What is
// asserted here is the half a Rust test cannot see: which version a row asks
// for, that restoring goes through `local_history_restore` (never a write or a
// checkout from the frontend), and that a file with nothing saved says so
// rather than showing an empty list.

const REPO = "/proj";
const FILE = "src/a.ts";

const bridge: {
  calls: { cmd: string; args: Record<string, unknown> }[];
  entries: { ts: number; blob: string; size: number }[];
  diff: string;
  restoreFails: string | null;
} = { calls: [], entries: [], diff: "", restoreFails: null };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "local_history_list") return Promise.resolve(bridge.entries);
    if (cmd === "local_history_diff") return Promise.resolve(bridge.diff);
    if (cmd === "local_history_restore") {
      return bridge.restoreFails ? Promise.reject(new Error(bridge.restoreFails)) : Promise.resolve(null);
    }
    return Promise.resolve(null);
  },
}));

import LocalHistory from "./LocalHistory";
import { OPEN_IN_EDITOR, TOAST } from "../../utils/events";

const entry = (ts: number, blob: string, size = 10) => ({ ts, blob, size });

function mount() {
  return render(() => <LocalHistory workspace={REPO} file={FILE} />);
}

const argsFor = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeEach(() => {
  bridge.calls = [];
  bridge.entries = [];
  bridge.diff = "";
  bridge.restoreFails = null;
});

describe("the list", () => {
  it("asks for this file's versions by absolute path", async () => {
    bridge.entries = [entry(1_700_000_000_000, "aaa")];
    mount();
    await waitFor(() => expect(argsFor("local_history_list")).toHaveLength(1));
    expect(argsFor("local_history_list")[0]).toEqual({ repoPath: REPO, path: `${REPO}/${FILE}` });
  });

  it("names the newest version as the last save", async () => {
    // The one version whose relationship to what is on screen is worth naming.
    bridge.entries = [entry(2000, "bbb"), entry(1000, "aaa")];
    mount();
    await waitFor(() => expect(screen.getByText("last save")).toBeTruthy());
    expect(screen.getAllByText("Restore")).toHaveLength(2);
  });

  it("says a file has nothing saved rather than showing an empty list", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/No saved versions yet/)).toBeTruthy());
  });
});

describe("looking at a version", () => {
  beforeEach(() => {
    bridge.entries = [entry(2000, "bbb"), entry(1000, "aaa")];
    bridge.diff = "@@ -1 +1 @@\n-one\n+two";
  });

  it("diffs the picked one against the file as it is now", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText("Restore")).toHaveLength(2));
    fireEvent.click(screen.getAllByText("Restore")[1].closest("div")!);

    await waitFor(() => expect(screen.getByText("-one")).toBeTruthy());
    expect(argsFor("local_history_diff")[0]).toEqual({ repoPath: REPO, path: `${REPO}/${FILE}`, ts: 1000 });
    expect(screen.getByText("+two")).toBeTruthy();
  });

  it("says so when a version is identical to the file, rather than showing nothing", async () => {
    // An empty diff and a failed read look the same on screen otherwise.
    bridge.diff = "";
    mount();
    await waitFor(() => expect(screen.getAllByText("Restore")).toHaveLength(2));
    fireEvent.click(screen.getAllByText("Restore")[0].closest("div")!);
    await waitFor(() => expect(screen.getByText(/Identical to the file/)).toBeTruthy());
  });

  it("closes the diff when the same row is picked again", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText("Restore")).toHaveLength(2));
    const row = () => screen.getAllByText("Restore")[0].closest("div")!;
    fireEvent.click(row());
    await waitFor(() => expect(screen.getByText("-one")).toBeTruthy());
    fireEvent.click(row());
    await waitFor(() => expect(screen.queryByText("-one")).toBeNull());
  });
});

describe("restoring one", () => {
  beforeEach(() => {
    bridge.entries = [entry(2000, "bbb"), entry(1000, "aaa")];
  });

  it("goes through the backend, never a write from here", async () => {
    // The restore has to leave the user's index alone, which is a property of
    // the command it goes through: an `fs_write_file` from the frontend would
    // put the bytes back but is not the seam that promise lives on.
    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    try {
      mount();
      await waitFor(() => expect(screen.getAllByText("Restore")).toHaveLength(2));
      fireEvent.click(screen.getAllByText("Restore")[1]);
      await waitFor(() => expect(argsFor("local_history_restore")).toHaveLength(1));
    } finally {
      window.removeEventListener(OPEN_IN_EDITOR, listener);
    }
    expect(argsFor("local_history_restore")[0]).toEqual({
      repoPath: REPO,
      path: `${REPO}/${FILE}`,
      ts: 1000,
    });
    expect(argsFor("fs_write_file")).toEqual([]);
    expect(opened).toEqual([`${REPO}/${FILE}`]);
  });

  it("re-reads the list, since the restore is itself a version to come", async () => {
    mount();
    await waitFor(() => expect(argsFor("local_history_list")).toHaveLength(1));
    fireEvent.click(screen.getAllByText("Restore")[0]);
    await waitFor(() => expect(argsFor("local_history_list")).toHaveLength(2));
  });

  it("says why when it fails, and leaves the list alone", async () => {
    bridge.restoreFails = "that version is no longer stored";
    const toasts: string[] = [];
    const listener = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, listener);
    try {
      mount();
      await waitFor(() => expect(screen.getAllByText("Restore")).toHaveLength(2));
      fireEvent.click(screen.getAllByText("Restore")[0]);
      await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    } finally {
      window.removeEventListener(TOAST, listener);
    }
    expect(toasts[0]).toContain("no longer stored");
    expect(screen.getAllByText("Restore")).toHaveLength(2);
  });
});

describe("local history, to axe", () => {
  it("has no accessibility violations", async () => {
    bridge.entries = [entry(2000, "bbb"), entry(1000, "aaa")];
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("last save")).toBeTruthy());

    await expectNoAxeViolations(container);
  });
});
