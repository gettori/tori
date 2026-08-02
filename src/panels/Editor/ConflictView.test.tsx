import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The conflict tab. The alignment itself is `conflict.test.ts`'s job; what is
// here is the view's own: that it reads the three stages, names the sides by
// the operation that is running, and that walking the conflicts moves through
// them one at a time.

// jsdom lays nothing out, so CodeMirror's measuring loop has nothing to measure.
// It mounts fine; this only keeps the observer from being missing outright.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const BASE = ["a", "b", "c", "d", "e", "f", "g", ""].join("\n");
const OURS = ["a", "O1", "c", "d", "e", "O2", "g", ""].join("\n");
const THEIRS = ["a", "T1", "c", "d", "e", "T2", "g", ""].join("\n");

let stages: unknown = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };
let op = "merge";
let stagesFails = false;
// What `git_status` answers next, for the one test that drives the shared store.
let statusRows: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "git_conflict_stages") {
      return stagesFails ? Promise.reject("f.txt has no merge conflict.") : Promise.resolve(stages);
    }
    if (cmd === "git_conflict_op") return Promise.resolve(op);
    if (cmd === "git_status") return Promise.resolve(statusRows);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ConflictView } = await import("./ConflictView");
const { refreshStatus } = await import("../../utils/gitActions");

let mounted: ReturnType<typeof render> | null = null;

function mount() {
  mounted = render(() => <ConflictView workspace="/proj" file="src/f.txt" />);
}

beforeEach(async () => {
  stages = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };
  op = "merge";
  stagesFails = false;
  statusRows = [];
  // The git store outlives any one mount. Selecting nothing is the app's reset.
  await refreshStatus(null);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conflict tab", () => {
  it("counts the conflicts and names the operation that made them", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("2 conflicts")).toBeTruthy());
    expect(screen.getByText("Merge")).toBeTruthy();
    expect(screen.getByText("src/f.txt")).toBeTruthy();
  });

  it("walks the conflicts one at a time, and stops at each end", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("2 conflicts")).toBeTruthy());
    const next = () => screen.getByTitle("Next conflict").closest("button")!;
    const prev = () => screen.getByTitle("Previous conflict").closest("button")!;

    // Nothing selected yet, so there is a next but no previous.
    expect(prev().disabled).toBe(true);

    fireEvent.click(next());
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    fireEvent.click(next());
    await waitFor(() => expect(screen.getByText("Conflict 2 of 2")).toBeTruthy());
    // The end of the walk is an answer, not a wrap back to the first.
    expect(next().disabled).toBe(true);

    fireEvent.click(prev());
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
  });

  it("shows what was there before the two sides disagreed", async () => {
    // The third document, and the reason this is a three-way view rather than
    // two versions side by side: "b" is what both sides rewrote.
    mount();
    await waitFor(() => expect(screen.getByText("2 conflicts")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Next conflict").closest("button")!);

    await waitFor(() => expect(screen.getByText("Base")).toBeTruthy());
    expect(screen.getByText("b")).toBeTruthy();
  });

  it("swaps which side is called yours under a rebase", async () => {
    // Same stages, opposite reading. Getting this wrong labels the upstream's
    // work as yours, which is both wrong and completely convincing.
    op = "merge";
    mount();
    await waitFor(() => expect(screen.getByText("2 conflicts")).toBeTruthy());
    const merged = screen.getByText(/Yours/).textContent;
    mounted!.unmount();

    op = "rebase";
    mount();
    await waitFor(() => expect(screen.getByText("Rebase")).toBeTruthy());

    expect(screen.getByText(/Yours/).textContent).not.toBe(merged);
    expect(screen.getByText("Upstream")).toBeTruthy();
  });

  it("re-reads when the file stops being conflicted under it", async () => {
    // Unlike a commit, what this tab shows can stop being true while it is
    // open: resolve the file in the terminal, or abort the merge, and the
    // stages are gone. Following the shared store costs one read on the
    // transition and keeps the tab from presenting an abandoned merge.
    await refreshStatus(null);
    statusRows = [{ status: "UU", path: "src/f.txt", staged: false, unstaged: false, conflicted: true }];
    await refreshStatus("/proj");
    mount();
    await waitFor(() => expect(screen.getByText("2 conflicts")).toBeTruthy());

    // Resolved elsewhere: the backend now refuses, and the store notices first.
    stagesFails = true;
    statusRows = [{ status: "M ", path: "src/f.txt", staged: true, unstaged: false, conflicted: false }];
    await refreshStatus("/proj");

    await waitFor(() => expect(screen.getByText(/no merge conflict/)).toBeTruthy());
    expect(screen.queryByText("2 conflicts")).toBeNull();
  });

  it("says a binary file has nothing to merge instead of showing bytes", async () => {
    stages = { base: null, ours: null, theirs: null, binary: true };
    mount();

    await waitFor(() => expect(screen.getByText(/binary/)).toBeTruthy());
    expect(screen.queryByText(/^Conflict \d/)).toBeNull();
  });

  it("shows the backend's reason when the file is not conflicted after all", async () => {
    // Reachable by opening the tab, resolving the file elsewhere, and coming
    // back to it: the stages are gone, and an empty pane would not say why.
    stagesFails = true;
    mount();

    await waitFor(() => expect(screen.getByText(/no merge conflict/)).toBeTruthy());
  });
});
