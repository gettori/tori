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
// The tab opens on the first conflict, which scrolls it into view, and that is
// the one thing jsdom's Range cannot survive: CodeMirror measures the text it
// is scrolling to. Nothing here asserts geometry, so empty rectangles are the
// right answer rather than a missing method.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const BASE = ["a", "b", "c", "d", "e", "f", "g", ""].join("\n");
const OURS = ["a", "O1", "c", "d", "e", "O2", "g", ""].join("\n");
const THEIRS = ["a", "T1", "c", "d", "e", "T2", "g", ""].join("\n");

let stages: unknown = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };
let op = "merge";
let stagesFails = false;
let resolveFails = false;
// What `git_status` answers next, for the one test that drives the shared store.
let statusRows: unknown[] = [];
/** Every `git_conflict_resolve` payload, which is what the choices add up to. */
let written: { file: string; content: string | null }[] = [];

/** Sessions the revert guard can see in this folder. */
let live: { sessionId: string; sessionName: string; folderPath: string; status: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "git_conflict_stages") {
      return stagesFails ? Promise.reject("f.txt has no merge conflict.") : Promise.resolve(stages);
    }
    if (cmd === "git_conflict_op") return Promise.resolve(op);
    if (cmd === "git_status") return Promise.resolve(statusRows);
    if (cmd === "git_conflict_resolve") {
      if (resolveFails) return Promise.reject("src/f.txt is no longer conflicted.");
      written.push({ file: args.file as string, content: args.content as string | null });
      return Promise.resolve(null);
    }
    // The guard's detached tier walks these two, and `folderActors` filters the
    // first without a null guard, so the catch-all below would throw before the
    // guard ever ran.
    if (cmd === "list_sessions" || cmd === "sessions_running") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../../utils/sessionActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/sessionActivity")>()),
  liveSessionStatuses: () => live,
}));

const { default: ConflictView } = await import("./ConflictView");
const { refreshStatus } = await import("../../utils/gitActions");
const { TOAST } = await import("../../utils/events");

let mounted: ReturnType<typeof render> | null = null;
let resolved: { restored: string[]; deleted: string[] }[] = [];

function mount() {
  mounted = render(() => (
    <ConflictView workspace="/proj" file="src/f.txt" onResolved={(o) => resolved.push(o)} />
  ));
}

/** The button for one decision, found by its title so the long side labels do
 *  not have to be repeated (and so a pane's own label cannot match instead). */
const byTitle = (t: string | RegExp) =>
  screen.getByTitle(t).closest("button") as HTMLButtonElement;
const markResolved = () =>
  screen.getByText(/mark resolved/i).closest("button") as HTMLButtonElement;
const nextConflict = () => screen.getByTitle("Next conflict").closest("button") as HTMLButtonElement;

/** Decide every conflict the same way, walking from the one the tab opened on. */
function decideAll(choice: string | RegExp) {
  for (;;) {
    fireEvent.click(byTitle(choice));
    if (nextConflict().disabled) return;
    fireEvent.click(nextConflict());
  }
}

beforeEach(async () => {
  stages = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };
  op = "merge";
  stagesFails = false;
  resolveFails = false;
  statusRows = [];
  written = [];
  resolved = [];
  live = [];
  // The git store outlives any one mount. Selecting nothing is the app's reset.
  await refreshStatus(null);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conflict tab", () => {
  it("opens on the first conflict, counted and named by the operation", async () => {
    // On the first rather than on nothing: everything that acts on a conflict
    // acts on the one being looked at, so an unselected tab offers navigation
    // and hides every decision behind it.
    mount();

    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    expect(screen.getByText("Merge")).toBeTruthy();
    expect(screen.getByText("src/f.txt")).toBeTruthy();
  });

  it("walks the conflicts one at a time, and stops at each end", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    const prev = () => screen.getByTitle("Previous conflict").closest("button")!;

    // At the first, so there is a next but no previous.
    expect(prev().disabled).toBe(true);

    fireEvent.click(nextConflict());
    await waitFor(() => expect(screen.getByText("Conflict 2 of 2")).toBeTruthy());
    // The end of the walk is an answer, not a wrap back to the first.
    expect(nextConflict().disabled).toBe(true);

    fireEvent.click(prev());
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
  });

  it("shows what was there before the two sides disagreed", async () => {
    // The third document, and the reason this is a three-way view rather than
    // two versions side by side: "b" is what both sides rewrote.
    mount();

    await waitFor(() => expect(screen.getByText("Base")).toBeTruthy());
    expect(screen.getByText("b")).toBeTruthy();
  });

  it("swaps which side is called yours under a rebase", async () => {
    // Same stages, opposite reading. Getting this wrong labels the upstream's
    // work as yours, which is both wrong and completely convincing.
    op = "merge";
    mount();
    await waitFor(() => expect(screen.getByTitle("Take Yours (HEAD)")).toBeTruthy());
    mounted!.unmount();

    op = "rebase";
    mount();
    await waitFor(() => expect(screen.getByText("Rebase")).toBeTruthy());

    expect(screen.getByTitle("Take Yours (being replayed)")).toBeTruthy();
    expect(screen.queryByTitle("Take Yours (HEAD)")).toBeNull();
    expect(screen.getByTitle("Take Upstream")).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // Resolved elsewhere: the backend now refuses, and the store notices first.
    stagesFails = true;
    statusRows = [{ status: "M ", path: "src/f.txt", staged: true, unstaged: false, conflicted: false }];
    await refreshStatus("/proj");

    await waitFor(() => expect(screen.getByText(/no merge conflict/)).toBeTruthy());
    expect(screen.queryByText("Conflict 1 of 2")).toBeNull();
  });

  it("writes the sides the reader picked, one conflict at a time", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // Nothing decided, so there is nothing to write and the button says why.
    expect(markResolved().disabled).toBe(true);
    expect(markResolved().title).toMatch(/2 conflicts still undecided/);

    fireEvent.click(byTitle("Take Yours (HEAD)"));
    // One down, and the button still refuses: a half-resolved file staged as
    // the answer is worse than no file, because it looks finished.
    expect(markResolved().disabled).toBe(true);
    fireEvent.click(nextConflict());
    fireEvent.click(byTitle("Take Incoming"));

    expect(markResolved().disabled).toBe(false);
    fireEvent.click(markResolved());

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].file).toBe("src/f.txt");
    // Ours at the first conflict, theirs at the second, and neither version's
    // untouched lines disturbed.
    expect(written[0].content).toBe(["a", "O1", "c", "d", "e", "T2", "g", ""].join("\n"));
    await waitFor(() => expect(screen.getByText(/Resolved\./)).toBeTruthy());
  });

  it("takes the side a rebase calls yours, which is the other stage", async () => {
    // The inversion, at the point it does damage: under a rebase the version
    // git labels "ours" is the upstream's. A button that offers it as yours
    // reads perfectly and stages somebody else's work over your commit.
    op = "rebase";
    mount();
    await waitFor(() => expect(screen.getByText("Rebase")).toBeTruthy());

    decideAll(/^Take Yours/);
    fireEvent.click(markResolved());

    await waitFor(() => expect(written).toHaveLength(1));
    // Stage 3, which under a merge would have been "incoming".
    expect(written[0].content).toBe(THEIRS);
  });

  it("keeps both versions, ours first, when both are accepted", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    decideAll(/Keep both versions/);
    fireEvent.click(markResolved());

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].content).toBe(["a", "O1", "T1", "c", "d", "e", "O2", "T2", "g", ""].join("\n"));
  });

  it("reports the rewritten file so an open buffer keeps its side", async () => {
    // The same channel a discard reports on: without it the next save of a
    // buffer open on this file writes the conflict back over the resolution.
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    decideAll("Take Yours (HEAD)");

    fireEvent.click(markResolved());

    await waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toEqual({ backstop_ts: null, restored: ["src/f.txt"], deleted: [] });
  });

  it("refuses to resolve while another session is mid-turn in the folder", async () => {
    // A resolution rewrites a whole file, which is the blast radius the guard
    // is about: the agent working here may be writing the very file being
    // replaced. Whole-file discard and every stash action ask the same.
    live = [
      { sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" },
    ];
    const toasts: string[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, onToast);
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    decideAll("Take Yours (HEAD)");

    fireEvent.click(markResolved());

    await waitFor(() => expect(toasts.join(" ")).toContain("docs-agent"));
    // A hard block, so it never even got as far as asking.
    expect(written).toEqual([]);
    expect(screen.queryByText("Resolve anyway")).toBeNull();
    window.removeEventListener(TOAST, onToast);
  });

  it("does not answer its own resolution with the backend's refusal", async () => {
    // Resolving makes the file stop being conflicted, which is exactly the
    // transition the tab follows in order to notice a merge finished in the
    // terminal. Following it here would re-read stages this tab just removed
    // and print "has no merge conflict" over the success that caused it.
    statusRows = [{ status: "UU", path: "src/f.txt", staged: false, unstaged: false, conflicted: true }];
    await refreshStatus("/proj");
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    decideAll("Take Yours (HEAD)");

    fireEvent.click(markResolved());
    await waitFor(() => expect(screen.getByText(/Resolved\./)).toBeTruthy());
    // Let the refresh the resolution kicked off finish first: `refreshStatus`
    // coalesces by root, so a call made while one is in flight joins it and
    // answers with the status that read, not the one set below.
    await refreshStatus("/proj");

    // What the world looks like a moment later, when the watcher's own re-read
    // lands: staged, and the stages gone, so asking for them would fail.
    statusRows = [{ status: "M ", path: "src/f.txt", staged: true, unstaged: false, conflicted: false }];
    stagesFails = true;
    await refreshStatus("/proj");

    expect(screen.getByText(/Resolved\./)).toBeTruthy();
    expect(screen.queryByText(/no merge conflict/)).toBeNull();
  });

  it("asks whether the file survives when one side deleted it", async () => {
    // A delete/modify conflict has no lines to choose between. Offering
    // "accept theirs" here would stage an empty file, which is a version
    // neither side wrote.
    stages = { base: BASE, ours: OURS, theirs: null, binary: false };
    mount();
    await waitFor(() => expect(screen.getByText(/deleted this file/)).toBeTruthy());
    expect(screen.queryByTitle("Next conflict")).toBeNull();

    fireEvent.click(byTitle("Accept the deletion"));
    fireEvent.click(screen.getByText("Delete and mark resolved").closest("button")!);

    // The one resolution with something to lose, so it says so and names the
    // way back before anything happens.
    const asked = await screen.findByText(/git checkout -m/);
    expect(asked.textContent).toContain("src/f.txt");
    fireEvent.click(screen.getByText("Delete file"));

    await waitFor(() => expect(written).toHaveLength(1));
    // No content at all, which is what says "gone" rather than "empty".
    expect(written[0].content).toBeNull();
    expect(resolved[0]).toEqual({ backstop_ts: null, restored: [], deleted: ["src/f.txt"] });
  });

  it("keeps the surviving side when that is the choice", async () => {
    stages = { base: BASE, ours: OURS, theirs: null, binary: false };
    mount();
    await waitFor(() => expect(screen.getByText(/deleted this file/)).toBeTruthy());

    fireEvent.click(byTitle(/^Keep the file/));
    fireEvent.click(screen.getByText("Mark resolved").closest("button")!);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].content).toBe(OURS);
  });

  it("stays a conflict when the write is refused", async () => {
    // The merge can be finished or aborted in the terminal while the tab is
    // open, and the backend refuses a stale resolution. Reporting that as done
    // would leave the reader believing they had resolved something.
    resolveFails = true;
    const toasts: string[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, onToast);
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    decideAll("Take Yours (HEAD)");

    fireEvent.click(markResolved());

    await waitFor(() => expect(toasts.join()).toMatch(/no longer conflicted/));
    expect(screen.queryByText(/Resolved\./)).toBeNull();
    expect(markResolved().disabled).toBe(false);
    window.removeEventListener(TOAST, onToast);
  });

  it("says a binary file has nothing to merge instead of showing bytes", async () => {
    stages = { base: null, ours: null, theirs: null, binary: true };
    mount();

    await waitFor(() => expect(screen.getByText(/binary/)).toBeTruthy());
    expect(screen.queryByText(/^Conflict \d/)).toBeNull();
  });

  it("offers no choice at all for a binary file one side deleted", async () => {
    // Both conditions at once. The keep/delete pair asks only about the file's
    // existence, so it looks answerable here, but keeping would write back the
    // lossy text this view is refusing to show, and there is no button to act
    // on the answer anyway.
    stages = { base: BASE, ours: null, theirs: " binary", binary: true };
    mount();

    await waitFor(() => expect(screen.getByText(/binary/)).toBeTruthy());
    expect(screen.queryByText(/deleted this file/)).toBeNull();
    expect(screen.queryByText(/mark resolved/i)).toBeNull();
  });

  it("is wired to the editor's buffer reconciliation", async () => {
    // The other half of the report, and the half a mount here cannot reach:
    // `onResolved` only reconciles anything if the editor hands it the same
    // handler a discard and a checkpoint revert use. Nothing else asserts the
    // tab is connected to it, so an unwired prop would pass every test above.
    const src = (await import("./Editor.tsx?raw")).default;

    expect(src).toMatch(/<ConflictView[\s\S]{0,200}?onResolved=\{handleReverted\}/);
  });

  it("shows the backend's reason when the file is not conflicted after all", async () => {
    // Reachable by opening the tab, resolving the file elsewhere, and coming
    // back to it: the stages are gone, and an empty pane would not say why.
    stagesFails = true;
    mount();

    await waitFor(() => expect(screen.getByText(/no merge conflict/)).toBeTruthy());
  });
});
