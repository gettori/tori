import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";
import { expectNoAxeViolations } from "../../test/axe";

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
let sides: unknown = null;
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
    if (cmd === "git_conflict_sides") return Promise.resolve(sides);
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
const { enterRoots, refreshStatus } = await import("../../utils/gitActions");
const { TOAST } = await import("../../utils/events");

let mounted: ReturnType<typeof render> | null = null;
let resolved: { restored: string[]; deleted: string[] }[] = [];

function mount(file = "src/f.txt") {
  mounted = render(() => <ConflictView workspace="/proj" file={file} onResolved={(o) => resolved.push(o)} />);
}

/** The button for one decision, found by its accessible name so the long side
 *  labels do not have to be repeated (and so a pane's own label cannot match
 *  instead). These used to be found by `title`; the sweep onto `Tooltip` moved
 *  that text onto `aria-label`, where it is a name rather than hover text.
 *
 *  Scoped to the header row, because the Result pane offers the same four
 *  decisions again on the conflict's own line and both routes carry the same
 *  name. `slotButton` below is how the other one is reached. */
const byName = (t: string | RegExp) =>
  screen
    .getAllByLabelText(t)
    .find((el) => !el.closest(".cm-result-slot"))!
    .closest("button") as HTMLButtonElement;

/** Every still-undecided slot offering this decision, inside the Result pane. */
const slotButtons = (t: string | RegExp) => screen.queryAllByLabelText(t).filter((el) => el.closest(".cm-result-slot"));

/** The first of them, which is the conflict the tab opened on. */
const slotButton = (t: string | RegExp) => slotButtons(t)[0] as HTMLButtonElement | undefined;

const markResolved = () => screen.getByText(/mark resolved/i).closest("button") as HTMLButtonElement;
const nextConflict = () => byName("Next conflict");

/** Decide every conflict the same way, walking from the one the tab opened on. */
function decideAll(choice: string | RegExp) {
  for (;;) {
    fireEvent.click(byName(choice));
    if (nextConflict().disabled) return;
    fireEvent.click(nextConflict());
  }
}

beforeEach(async () => {
  stages = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };
  op = "merge";
  sides = null;
  stagesFails = false;
  resolveFails = false;
  statusRows = [];
  written = [];
  resolved = [];
  live = [];
  // The git store outlives any one mount. Re-entering the root is the app's
  // reset: it drops every other slot and seeds this one blank.
  enterRoots(["/proj"]);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conflict tab", () => {
  it("has no accessibility violations", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // The panel is inline rather than portalled, so its own container is the
    // right scope. It runs here and not on DebugPanel because this file already
    // had a mounted test to hang it on - see the phase notes for the gap.
    await expectNoAxeViolations(mounted!.container);
  });

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
    const prev = () => byName("Previous conflict");

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
    await waitFor(() => expect(byName("Take Yours (HEAD)")).toBeTruthy());
    mounted!.unmount();

    op = "rebase";
    mount();
    await waitFor(() => expect(screen.getByText("Rebase")).toBeTruthy());

    expect(byName("Take Yours (being replayed)")).toBeTruthy();
    expect(screen.queryByTitle("Take Yours (HEAD)")).toBeNull();
    expect(byName("Take Upstream")).toBeTruthy();
  });

  it("re-reads when the file stops being conflicted under it", async () => {
    // Unlike a commit, what this tab shows can stop being true while it is
    // open: resolve the file in the terminal, or abort the merge, and the
    // stages are gone. Following the shared store costs one read on the
    // transition and keeps the tab from presenting an abandoned merge.
    enterRoots(["/proj"]);
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
    // A disabled button fires no pointer events, so the explanation is reached
    // through the hover surface `tooltipWhenDisabled` puts around it - which is
    // the whole reason this control opted into that.
    expect(markResolved().disabled).toBe(true);
    fireEvent.pointerEnter(markResolved().closest("[data-tooltip-hover-surface]")!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toMatch(/2 conflicts still undecided/));

    fireEvent.click(byName("Take Yours (HEAD)"));
    // One down, and the button still refuses: a half-resolved file staged as
    // the answer is worse than no file, because it looks finished.
    expect(markResolved().disabled).toBe(true);
    fireEvent.click(nextConflict());
    fireEvent.click(byName("Take Incoming"));

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
    live = [{ sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" }];
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
    expect(screen.queryByLabelText("Next conflict")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete the file" }));
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

    // By its visible text: "Keep both versions" is also on screen, and this is
    // the one naming the side that survived the delete.
    fireEvent.click(screen.getByRole("button", { name: "Keep Yours (HEAD)" }));
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

describe("actions in the side panes", () => {
  const resultDoc = () =>
    EditorView.findFromDOM(
      mounted!.container.querySelector('[aria-label="Result"]')!.closest(".cm-editor") as HTMLElement,
    )!.state.doc.toString();

  it("hides a side's row once that side is in the Result, and leaves the other's up", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    expect(screen.queryAllByLabelText("Accept Yours (HEAD)")).toHaveLength(2);
    expect(screen.queryAllByLabelText("Accept Incoming")).toHaveLength(2);

    fireEvent.click(byName("Take Yours (HEAD)"));

    expect(screen.queryAllByLabelText("Accept Yours (HEAD)")).toHaveLength(1);
    expect(screen.queryAllByLabelText("Accept Incoming")).toHaveLength(2);
  });

  it("keeps both when the other side is accepted from its own pane", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Take Yours (HEAD)"));
    fireEvent.click(screen.getAllByLabelText("Accept Incoming")[0]);

    expect(byName("Keep both versions, ours first").getAttribute("aria-pressed")).toBe("true");
  });

  it("settles a conflict whose two sides are both ignored, until one is taken back", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    const before = resultDoc();

    for (const side of ["Yours (HEAD)", "Incoming"]) {
      for (const button of screen.getAllByLabelText(`Ignore ${side}`)) fireEvent.click(button);
    }

    expect(markResolved().disabled).toBe(false);
    expect(resultDoc()).toBe(before);

    fireEvent.click(screen.getAllByLabelText("Stop ignoring Incoming")[0]);
    expect(markResolved().disabled).toBe(true);
  });

  it("names the commit and ref behind each side, the right way round under a rebase", async () => {
    const main = { sha: "a".repeat(40), short: "aaaaaaa", name: "main" };
    const feature = { sha: "b".repeat(40), short: "bbbbbbb", name: "feature" };
    const header = (ref: string) => screen.getByText(ref).parentElement!.textContent;

    sides = { ours: main, theirs: feature };
    mount();
    await waitFor(() => expect(screen.getByText("main aaaaaaa")).toBeTruthy());
    expect(header("main aaaaaaa")).toBe("Yours (HEAD)main aaaaaaa");
    expect(header("feature bbbbbbb")).toBe("Incomingfeature bbbbbbb");
    mounted!.unmount();

    op = "rebase";
    sides = { ours: feature, theirs: main };
    mount();
    await waitFor(() => expect(screen.getByText("main aaaaaaa")).toBeTruthy());
    expect(header("main aaaaaaa")).toBe("Yours (being replayed)main aaaaaaa");
    expect(header("feature bbbbbbb")).toBe("Upstreamfeature bbbbbbb");
  });
});

describe("keeping both sides", () => {
  /** Whether the header row offers a decision by this exact name. */
  const offered = (name: string) => screen.queryAllByLabelText(name).some((el) => !el.closest(".cm-result-slot"));

  it("offers a combination where the sides edit different halves of a line, and plain both where they collide", async () => {
    stages = {
      base: ["x = 1, y = 2;", "keep", "z = 3;", ""].join("\n"),
      ours: ["x = 10, y = 2;", "keep", "z = 7;", ""].join("\n"),
      theirs: ["x = 1, y = 20;", "keep", "z = 9;", ""].join("\n"),
      binary: false,
    };
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // Both orders give the same line here, so the combination names no order.
    expect(offered("Combine both sides' edits")).toBe(true);
    expect(offered("Keep both versions, ours first")).toBe(false);
    fireEvent.click(byName("Combine both sides' edits"));

    fireEvent.click(nextConflict());
    expect(offered("Combine both sides' edits")).toBe(false);
    expect(offered("Keep both versions, ours first")).toBe(true);
    fireEvent.click(byName("Take Yours (HEAD)"));

    fireEvent.click(markResolved());
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].content).toBe(["x = 10, y = 20;", "keep", "z = 7;", ""].join("\n"));
  });

  it("names the order only when the order changes the text", async () => {
    stages = { base: "a\nc\n", ours: "a\nx\nc\n", theirs: "a\ny\nc\n", binary: false };
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 1")).toBeTruthy());

    expect(offered("Combine both sides' edits")).toBe(false);
    expect(offered("Combine both sides' edits, Yours (HEAD) first")).toBe(true);
    expect(offered("Combine both sides' edits, Incoming first")).toBe(true);
  });
});

describe("the Result pane", () => {
  /** The pane's own editor, reached through the name it carries for the same
   *  reason the two above it do. */
  function result() {
    const content = mounted!.container.querySelector('[aria-label="Result"]')!;
    return EditorView.findFromDOM(content.closest(".cm-editor") as HTMLElement)!;
  }
  const doc = () => result().state.doc.toString();

  /** Where the first undecided conflict's blank line starts. */
  const slotAt = () => doc().indexOf("\n\n") + 1;

  it("opens with a blank line held where each conflict will go", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // The untouched lines are already the answer; only the two disputed ones
    // are waiting, and each is offered on its own line rather than in a list
    // somewhere else.
    expect(doc()).toBe(["a", "", "c", "d", "e", "", "g", ""].join("\n"));
    expect(slotButton("Take Yours (HEAD)")).toBeTruthy();
  });

  it("answers a conflict from its own line, and the header agrees", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(slotButton("Write these lines yourself")!);

    // One decision, two places showing it: a reader who used the slot must not
    // find the header still asking.
    expect(byName("Write these lines yourself").getAttribute("aria-pressed")).toBe("true");
    // `hand` leaves the blank line alone, because that line is where the
    // reader is about to type.
    expect(doc()).toBe(["a", "", "c", "d", "e", "", "g", ""].join("\n"));
    // And that slot stops asking, since it has its answer. The other conflict
    // is still open, so its own line still offers all four.
    expect(slotButtons("Write these lines yourself")).toHaveLength(1);
  });

  it("replaces a taken side rather than stacking the next one after it", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Take Yours (HEAD)"));
    expect(doc()).toBe(["a", "O1", "c", "d", "e", "", "g", ""].join("\n"));

    fireEvent.click(byName("Take Incoming"));

    // Changing your mind is a replacement, not an append: the span moved with
    // the first take, so the second lands on it.
    expect(doc()).toBe(["a", "T1", "c", "d", "e", "", "g", ""].join("\n"));
  });

  it("keeps a conflict undecided when the reader only types at it", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    result().dispatch({ changes: { from: slotAt(), insert: "MINE" } });

    // Typing beside a slot is an edit, not an answer. Nothing else can tell
    // half-finished text from a decision, so the button has to be pressed.
    expect(markResolved().disabled).toBe(true);
    expect(slotButton("Take Yours (HEAD)")).toBeTruthy();
  });

  it("says what a decided conflict holds, and takes one side back out", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Take Yours (HEAD)"));
    fireEvent.click(screen.getAllByLabelText("Accept Incoming")[0]);
    expect(doc()).toBe(["a", "O1", "T1", "c", "d", "e", "", "g", ""].join("\n"));
    expect(screen.getByText("Holds both versions, ours first")).toBeTruthy();

    fireEvent.click(slotButton("Remove Incoming")!);

    expect(doc()).toBe(["a", "O1", "c", "d", "e", "", "g", ""].join("\n"));
    expect(screen.getByText("Holds Yours (HEAD)")).toBeTruthy();
  });

  it("reads a decided conflict typed over as written by hand, and resets it to the base", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Take Yours (HEAD)"));
    result().dispatch({ changes: { from: doc().indexOf("O1") + 2, insert: "!" } });

    expect(byName("Write these lines yourself").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Written by hand")).toBeTruthy();

    fireEvent.click(slotButton("Reset to base")!);
    fireEvent.click(await screen.findByText("Discard edits"));

    await waitFor(() => expect(doc()).toBe(["a", "b", "c", "d", "e", "", "g", ""].join("\n")));
    expect(slotButtons("Take Yours (HEAD)")).toHaveLength(2);
  });

  it("asks before a choice replaces what the reader typed, and leaves it alone on no", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Take Yours (HEAD)"));
    result().dispatch({ changes: { from: doc().indexOf("O1") + 2, insert: "!" } });
    const typed = doc();

    fireEvent.click(byName("Take Incoming"));
    await waitFor(() => expect(screen.getByText("Discard your edits?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(screen.queryByText("Discard your edits?")).toBeNull());
    expect(doc()).toBe(typed);
  });

  it("takes what the reader typed above a slot with them", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    // An insertion above the first slot moves both slots down. A span kept
    // outside the document would still be pointing at "a".
    result().dispatch({ changes: { from: 0, insert: "header\n" } });
    fireEvent.click(byName("Take Yours (HEAD)"));

    expect(doc()).toBe(["header", "a", "O1", "c", "d", "e", "", "g", ""].join("\n"));
  });

  it("writes the document, hand edits and all", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    decideAll("Take Yours (HEAD)");
    // The line neither side wrote, which is the whole reason the pane is
    // editable: without it this merge can only be resolved wrong and fixed
    // afterwards.
    result().dispatch({ changes: { from: doc().length, insert: "mine\n" } });

    fireEvent.click(markResolved());

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].content).toBe(["a", "O1", "c", "d", "e", "O2", "g", "mine", ""].join("\n"));
  });

  it("resolves a conflict left to the reader as whatever they left there", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());

    fireEvent.click(byName("Write these lines yourself"));
    fireEvent.click(nextConflict());
    fireEvent.click(byName("Take Yours (HEAD)"));

    // Every conflict has an answer now, even though one of them is a blank
    // line: "neither of these" is a decision the other three cannot express.
    expect(markResolved().disabled).toBe(false);
    fireEvent.click(markResolved());

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].content).toBe(["a", "", "c", "d", "e", "O2", "g", ""].join("\n"));
  });

  it("is not offered for a file one side deleted", async () => {
    // There are no lines to merge, only the question of whether the file
    // survives, so a pane offering to edit its contents would be answering
    // something nobody asked.
    stages = { base: BASE, ours: OURS, theirs: null, binary: false };
    mount();

    await waitFor(() => expect(screen.getByText(/deleted this file/)).toBeTruthy());
    expect(mounted!.container.querySelector('[aria-label="Result"]')).toBeNull();
  });
});

describe("lining the panes up", () => {
  const viewNamed = (name: string) =>
    EditorView.findFromDOM(
      mounted!.container.querySelector(`[aria-label="${name}"]`)!.closest(".cm-editor") as HTMLElement,
    )!;

  // The offsets themselves are `paneAlign.test.tsx`'s: jsdom measures these
  // panes at zero height once MergeView scrolls them, so here only the wiring
  // can be seen.
  it("gives both side panes the same space where the Result runs taller", async () => {
    stages = { base: "a\nb\nc\n", ours: "a\nO1\nO2\nO3\nc\n", theirs: "a\nT1\nc\n", binary: false };
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 1")).toBeTruthy());
    const result = viewNamed("Result");
    const space = (name: string) =>
      [...viewNamed(name).contentDOM.querySelectorAll<HTMLElement>(".cm-align-spacer")].map((el) => el.style.height);

    result.dispatch({ changes: { from: result.state.doc.line(2).from, insert: "W\nX\nY\nZ\n" } });

    await waitFor(() => expect(space("Yours (HEAD)").length).toBeGreaterThan(0));
    expect(space("Incoming")).toEqual(space("Yours (HEAD)"));
  });

  it("scrolls the panes and the Result together", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    // jsdom lays nothing out, so scrollTop is a plain number here, and a change
    // fires the event a browser would.
    const scrollable = (el: HTMLElement) => {
      let top = 0;
      Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          if (v === top) return;
          top = v;
          el.dispatchEvent(new Event("scroll"));
        },
      });
      return el;
    };
    const panes = scrollable(mounted!.container.querySelector(".cm-mergeView") as HTMLElement);
    const result = scrollable(viewNamed("Result").dom.parentElement!);

    panes.scrollTop = 120;
    expect(result.scrollTop).toBe(120);

    result.scrollTop = 40;
    expect(panes.scrollTop).toBe(40);
  });
});

describe("which two versions the panes compare", () => {
  it("keeps the decisions, the place and the document across a switch", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Conflict 1 of 2")).toBeTruthy());
    const content = () => mounted!.container.querySelector('[aria-label="Result"]')!;
    const doc = () => EditorView.findFromDOM(content().closest(".cm-editor") as HTMLElement)!.state.doc.toString();

    fireEvent.click(byName("Take Yours (HEAD)"));
    const before = doc();

    fireEvent.click(byName("Compare Base with Incoming"));

    // The pair is a question about the two candidates. Nothing about it is an
    // answer, so rebuilding the panes for it must not cost the reader the
    // answers they already gave or the lines they already wrote.
    expect(screen.getByText("Conflict 1 of 2")).toBeTruthy();
    expect(byName("Take Yours (HEAD)").getAttribute("aria-pressed")).toBe("true");
    expect(doc()).toBe(before);
    expect(screen.getByLabelText("Base")).toBeTruthy();
    expect(screen.getByLabelText("Incoming")).toBeTruthy();
    // The side that is no longer on screen is no longer a pane.
    expect(screen.queryByLabelText("Yours (HEAD)")).toBeNull();
  });
});

describe("reading the code in the panes", () => {
  it("colours every pane once the language pack lands", async () => {
    // The pack is fetched per file and arrives after the panes are already up,
    // so this is really a test that the late arrival reaches them at all: the
    // panes are built once and never rebuilt for it.
    stages = {
      base: "const a = 1\n",
      ours: "const a = 2\n",
      theirs: "const a = 3\n",
      binary: false,
    };
    mount("src/f.ts");
    await waitFor(() => expect(screen.getByText("Conflict 1 of 1")).toBeTruthy());

    for (const pane of ["Yours (HEAD)", "Incoming", "Result"]) {
      await waitFor(() =>
        expect(screen.getByLabelText(pane).querySelector("span[class]"), `${pane} is painted`).toBeTruthy(),
      );
    }
  });
});
