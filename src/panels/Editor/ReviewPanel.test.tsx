import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import type { FileStatus } from "../../utils/gitActions";

// The Changes panel's reaction to the filesystem watcher, driven through the
// real component. What is asserted here is strictly the panel's own job: which
// watcher bursts make it refetch the diff it currently has expanded. Refetching
// is not free (it drops the gaps the user expanded), so "refetch on everything"
// is a bug, not a conservative default.

// The panel measures itself to pick side-by-side vs inline. jsdom reports every
// width as zero, so the observer never has anything to say - it only has to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "",
].join("\n");

const calls: { status: number; diff: number } = { status: 0, diff: 0 };

// What `git_ahead_behind` reports, and what `git_commit` was called with. Both
// drive the amend guard, which is the only thing here that asks the backend a
// question whose answer changes what the panel does rather than what it shows.
let aheadBehind: { ahead: number; behind: number; has_upstream: boolean } | null = null;
// The header only renders once the store knows a branch, so the tests that are
// about the header say so by naming one.
let branches: { name: string; current: boolean }[] = [];
let headMsg = "";
let commitArgs: unknown[] = [];
// Discard is the one destructive thing this panel does, so what it was asked to
// do (and who was in the way) is worth recording exactly.
let discardArgs: { cmd: string; args: unknown }[] = [];
// What a line-level stage asked for. The indices only mean anything alongside
// the fingerprint they were picked against, so both are recorded.
let applyLineArgs: unknown[] = [];
let stashArgs: { cmd: string; args: unknown }[] = [];
let stashRows: { selector: string; message: string; branch: string | null; relative_date: string }[] = [];
let stashCreated = true;
let stashFails = false;
let live: { sessionId: string; sessionName: string; folderPath: string; status: string }[] = [];
// The "Open PR" button's three paths turn on these three answers, so each test
// says which world it is in rather than sharing one.
let originUrl: string | null = null;
let defaultBase: string | null = null;
let authState: { kind: string; login?: string } = { kind: "signedOut" };
// What `github_push_and_create_pr` was called with, and what it answers. An
// empty array after a click is the assertion that nothing was sent.
let createPrArgs: unknown[] = [];
let createPrFails: unknown = null;

vi.mock("../../utils/sessionActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/sessionActivity")>()),
  liveSessionStatuses: () => live,
}));

const UNSTAGED = { status: " M", path: "src/a.ts", staged: false, unstaged: true };
const STAGED = { status: "M ", path: "src/a.ts", staged: true, unstaged: false };
// The index as the backend would report it next. `git_stage` moves it, so a
// panel that re-read the status shows the file under a different heading.
let statusRows: FileStatus[] = [UNSTAGED];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "git_stage":
        statusRows = [STAGED];
        return Promise.resolve(null);
      case "git_status":
        calls.status += 1;
        return Promise.resolve(statusRows);
      case "git_diff_text":
        calls.diff += 1;
        return Promise.resolve(DIFF);
      case "git_ahead_behind":
        return Promise.resolve(aheadBehind);
      case "git_head_message":
        return Promise.resolve(headMsg);
      case "git_commit":
        commitArgs.push(args);
        return Promise.resolve(null);
      case "git_discard_hunks":
      case "git_discard_files":
        discardArgs.push({ cmd, args });
        return Promise.resolve({ backstop_ts: 1_700_000_000, restored: ["src/a.ts"], deleted: [] });
      case "git_apply_lines":
        applyLineArgs.push(args);
        return Promise.resolve(null);
      case "git_stash_list":
        return Promise.resolve(stashRows);
      case "git_stash_push":
        stashArgs.push({ cmd, args });
        return Promise.resolve(stashCreated);
      case "git_stash_apply":
        stashArgs.push({ cmd, args });
        if (stashFails) return Promise.reject("error: Your local changes to src/a.ts would be overwritten");
        return Promise.resolve({ restored: ["src/a.ts"], deleted: [] });
      case "git_stash_drop":
        stashArgs.push({ cmd, args });
        return Promise.resolve(null);
      case "list_branches":
        return Promise.resolve(branches);
      case "git_origin":
        return Promise.resolve(originUrl);
      case "git_default_base_branch":
        return Promise.resolve(defaultBase);
      case "github_auth_state":
        return Promise.resolve(authState);
      // The backend echoes back what it persisted, which is what puts the
      // settings store into agreement. Returning the default `null` would land
      // a null settings object in the store instead.
      case "set_settings":
        return Promise.resolve((args as { settings: unknown }).settings);
      case "github_push_and_create_pr":
        createPrArgs.push(args);
        if (createPrFails) return Promise.reject(createPrFails);
        return Promise.resolve({
          number: 42,
          title: "t",
          body: null,
          state: "open",
          isDraft: false,
          author: "skarif2",
          headRef: "wave-3",
          baseRef: "main",
          headSha: "abc",
          url: "https://github.com/skarif2/sway/pull/42",
          mergeableState: "unknown",
        });
      // The revert guard's detached tier walks these two. They return arrays
      // for real, and `folderActors` filters the first without a null guard, so
      // the catch-all `null` below would throw before the guard ever ran.
      case "list_sessions":
      case "sessions_running":
        return Promise.resolve([]);
      // Reading a conflict is what composing an "ask agent to resolve" starts
      // with; the wording itself is asserted where the composer lives.
      case "git_conflict_stages":
        return Promise.resolve({ base: "one\n", ours: "OURS\n", theirs: "THEIRS\n", binary: false });
      case "git_conflict_op":
        return Promise.resolve("merge");
      // The turn strip only reads these once a session is selected, and it
      // measures the answer's length rather than try/catching it, so `null`
      // would be a crash rather than an empty timeline.
      case "checkpoint_list":
      case "backstop_list":
        return Promise.resolve([]);
      // checkpoint_turn_files / git_ahead_behind / git_origin /
      // git_default_base_branch: the panel try/catches each one, so a null is a
      // fine stand-in for every backend call this test does not drive.
      default:
        return Promise.resolve(null);
    }
  },
}));

// An array per event name, not one handler per name. ReviewPanel renders
// CheckpointTimeline unconditionally, and it registers a second `fs://changed`
// listener of its own; a `handlers[name] = fn` map would let whichever mounted
// last silently shadow the listener under test.
const handlers: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import ReviewPanel from "./ReviewPanel";
import { parseDiffHunks } from "../../utils/diffHunks";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { stage, refreshStatus } from "../../utils/gitActions";
import {
  TOAST,
  OPEN_IN_EDITOR,
  SEND_TO_SESSION,
  SEND_TO_SESSION_RESULT,
  type ToastEvent,
} from "../../utils/events";
import { saveSettings, DEFAULT_SETTINGS } from "../Settings/settingsStore";
import { BLOCKED_REASON } from "../../utils/safeSend";
import { syntheticId } from "../../utils/syntheticTabs";

/** Collects toast messages until `stop()`. `emitWith` is a window CustomEvent,
 *  not the Tauri event bus, so mocking the transport would never see one. */
function captureToasts() {
  const messages: string[] = [];
  const onToast = (e: Event) => messages.push((e as CustomEvent<ToastEvent>).detail.message);
  window.addEventListener(TOAST, onToast);
  return { messages, stop: () => window.removeEventListener(TOAST, onToast) };
}

/** The create-PR dialog's own subtree.
 *
 *  Scoped because the commit composer behind the modal carries a button with the
 *  same "Ask agent to draft" label, so an unscoped query matches both. Scoped by
 *  role rather than by the title's parent: since the dialog moved onto `Dialog`,
 *  that parent is the heading row rather than the whole panel. */
function prDialog() {
  return within(screen.getByRole("dialog"));
}

/** One watcher burst, delivered to every registered `fs://changed` listener. */
function fsBurst(paths: string[]) {
  for (const fn of handlers["fs://changed"] ?? []) fn({ payload: { paths } });
}

beforeEach(async () => {
  // The git store outlives any one panel, so the previous test's index would
  // otherwise still be loaded. Selecting nothing is the reset the app uses.
  await refreshStatus(null);
  statusRows = [UNSTAGED];
  calls.status = 0;
  calls.diff = 0;
  aheadBehind = null;
  branches = [];
  headMsg = "";
  commitArgs = [];
  discardArgs = [];
  applyLineArgs = [];
  stashArgs = [];
  stashRows = [];
  stashCreated = true;
  stashFails = false;
  live = [];
  originUrl = null;
  defaultBase = null;
  authState = { kind: "signedOut" };
  createPrArgs = [];
  createPrFails = null;
  // `github` is named explicitly rather than left to the spread: the settings
  // store is created *over* DEFAULT_SETTINGS, so writing to the store mutates
  // that object in place. A test that switches the integration off leaves
  // `DEFAULT_SETTINGS.github.enabled === false` behind it, and a reset that
  // spreads the same object would faithfully restore the wrong value.
  await saveSettings({ ...DEFAULT_SETTINGS, github: { enabled: true } });
  for (const key of Object.keys(handlers)) delete handlers[key];
});

/** Mount the panel and wait until both `fs://changed` listeners have registered.
 *
 *  The second one is CheckpointTimeline's, and it is the whole reason `handlers`
 *  keeps an array: a one-handler-per-name map would let it shadow the listener
 *  under test, and these tests would then pass or fail on mount order. Asserting
 *  it is present keeps that hazard visible if the child ever stops listening. */
async function mountPanel() {
  render(() => <ReviewPanel root="/proj" selected={null} />);
  await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());
  await waitFor(() =>
    expect(
      handlers["fs://changed"]?.length,
      "expected ReviewPanel and CheckpointTimeline to each register an fs://changed listener",
    ).toBeGreaterThan(1),
  );
}

/** Mount and expand `src/a.ts`, leaving exactly one diff fetch spent. */
async function mountWithOpenDiff() {
  await mountPanel();
  fireEvent.click(screen.getByTitle("src/a.ts"));
  await waitFor(() => expect(calls.diff).toBe(1));
}

describe("the shared git store", () => {
  it("moves a file to Staged when something outside the panel stages it", async () => {
    // What the command palette's "Stage this file" runs. The panel used to hold
    // its own `git_status` signal, so an action from anywhere else left it
    // showing the file as unstaged until something happened to refresh it.
    await mountPanel();
    expect(screen.queryByText("Staged Changes")).toBeNull();

    await stage("/proj", ["src/a.ts"]);

    await waitFor(() => expect(screen.getByText("Staged Changes")).toBeTruthy());
    expect(screen.queryByText("Changes")).toBeNull();
  });
});

describe("expanded diff refetch", () => {
  it("ignores a burst that does not name the open file", async () => {
    await mountWithOpenDiff();

    const statusBefore = calls.status;
    fsBurst(["/proj/src/other.ts"]);
    // The burst's unconditional `git_status` refresh is the synchronisation
    // point: once it lands, the handler has run to completion, so a diff count
    // that has not moved is a real skip rather than a race.
    await waitFor(() => expect(calls.status).toBeGreaterThan(statusBefore));
    expect(calls.diff).toBe(1);
  });

  it("refetches when a burst names the open file", async () => {
    await mountWithOpenDiff();

    fsBurst(["/proj/src/a.ts"]);
    await waitFor(() => expect(calls.diff).toBe(2));
  });

  it("refetches when the open file rides along in a multi-path burst", async () => {
    await mountWithOpenDiff();

    fsBurst(["/proj/src/other.ts", "/proj/src/a.ts", "/proj/README.md"]);
    await waitFor(() => expect(calls.diff).toBe(2));
  });

  it("ignores every burst when no diff is expanded", async () => {
    await mountPanel();

    const statusBefore = calls.status;
    fsBurst(["/proj/src/a.ts"]);
    await waitFor(() => expect(calls.status).toBeGreaterThan(statusBefore));
    expect(calls.diff).toBe(0);
  });
});

describe("renames", () => {
  it("names both halves in one row, and acts on the destination", async () => {
    // What `--porcelain=v2 -z` now reports: a real pathspec plus the source
    // beside it, instead of v1's single unusable "before.txt -> after.txt".
    statusRows = [
      { status: "R ", path: "after.txt", orig_path: "before.txt", staged: true, unstaged: false },
    ];
    render(() => <ReviewPanel root="/proj" selected={null} />);

    const row = await screen.findByTitle("after.txt");
    expect(row.textContent).toContain("before.txt");
    expect(row.textContent).toContain("after.txt");
    // The row's own title is the pathspec, not the display string, so every
    // action on it (stage, unstage, diff) addresses a file that exists.
    expect(row.getAttribute("title")).toBe("after.txt");
  });
});

describe("conflicts", () => {
  // What the backend reports for a `u` record: neither staged nor unstaged, so
  // the file falls out of both sections and has to be given one of its own.
  const CONFLICT: FileStatus = {
    status: "UU",
    path: "src/c.ts",
    staged: false,
    unstaged: false,
    conflicted: true,
  };

  it("lists a conflicted file in its own section and nowhere else", async () => {
    statusRows = [CONFLICT, UNSTAGED];
    render(() => <ReviewPanel root="/proj" selected={null} />);

    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());
    // One row, not one per section: the file is not also sitting under Changes
    // or Staged Changes wearing a Stage button.
    const rows = screen.getAllByTitle("src/c.ts");
    expect(rows).toHaveLength(1);
    // The row is the control, so it is a button: opening the file is its main
    // action, and a div would make the whole section mouse-only. Nothing is
    // nested inside it - stage, unstage and discard are all refused here, and
    // the one action it does have sits beside it, since a button inside a
    // button is not clickable in its own right.
    expect(rows[0].tagName).toBe("BUTTON");
    expect(rows[0].querySelectorAll("button")).toHaveLength(0);
    // The ordinary file beside it still gets its section and its controls, so
    // the conflict section is an addition rather than a takeover.
    expect(screen.getByText("Changes")).toBeTruthy();
    expect(screen.getByTitle("src/a.ts").querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("opens the three-way view rather than git's marker-riddled file", async () => {
    // The file on disk is git's attempt at the merge; the three versions behind
    // it are the thing to choose between. Going via the file would mean finding
    // the banner and clicking a second time.
    statusRows = [CONFLICT];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());

    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    fireEvent.click(screen.getByTitle("src/c.ts"));
    window.removeEventListener(OPEN_IN_EDITOR, listener);

    expect(opened).toEqual([syntheticId("conflict", "/proj", "src/c.ts")]);
  });

  it("offers the conflict to the agent, and says why when there is no session to offer it to", async () => {
    // Safe-send's capability gate, the same one the commit draft sits behind:
    // with nothing selected there is nowhere for the text to land, and a
    // disabled button that never says why reads as a broken control.
    statusRows = [CONFLICT];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());

    const ask = screen.getByText("Ask agent").closest("button") as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toBe("Select a session first");
  });

  it("asks about a second conflicted file while the first is still in flight", async () => {
    // Two conflicted files are two questions. An in-flight request is tracked
    // per path, so the second row's button acts rather than looking enabled and
    // doing nothing while the first waits for a session that may be booting.
    const OTHER: FileStatus = { ...CONFLICT, path: "src/d.ts" };
    statusRows = [CONFLICT, OTHER];
    const selected = { folderPath: "/proj", sessionId: "s1", agent: "claude", sessionCwd: "/proj" };
    render(() => <ReviewPanel root="/proj" selected={selected as never} />);
    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());

    // Nothing answers the requests: this is exactly the window in which the
    // second row has to stay usable.
    const sent: { text: string }[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<{ text: string }>).detail);
    window.addEventListener(SEND_TO_SESSION, listener);
    for (const ask of screen.getAllByText("Ask agent")) fireEvent.click(ask);
    await waitFor(() => expect(sent).toHaveLength(2));
    window.removeEventListener(SEND_TO_SESSION, listener);

    expect(sent[0].text).toContain("@src/c.ts");
    expect(sent[1].text).toContain("@src/d.ts");
  });

  it("does not offer to stash a tree git will not stash", async () => {
    // `git stash` refuses an unmerged tree outright, so an enabled button here
    // could only ever produce git's error message.
    statusRows = [CONFLICT, UNSTAGED];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());

    // `Button` puts its label in a span, so the control is the ancestor.
    const stashAll = () => screen.getByText("Stash all").closest("button")!;
    expect(stashAll().disabled).toBe(true);
    expect(stashAll().getAttribute("title")).toMatch(/merge is unresolved/);

    statusRows = [UNSTAGED];
    await refreshStatus("/proj");

    await waitFor(() => expect(stashAll().disabled).toBe(false));
  });

  it("drops the section once the last conflict is marked resolved", async () => {
    statusRows = [CONFLICT];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByText("Conflicts")).toBeTruthy());

    // `git add` on a conflicted path is what "mark resolved" means: one index
    // stage where there were three, so the next status has no `u` record.
    statusRows = [{ status: "M ", path: "src/c.ts", staged: true, unstaged: false, conflicted: false }];
    await refreshStatus("/proj");

    await waitFor(() => expect(screen.queryByText("Conflicts")).toBeNull());
    expect(screen.getByText("Staged Changes")).toBeTruthy();
  });
});

describe("line-level staging", () => {
  // The fixture is one hunk whose body is [" one", "-two", "+TWO", " three"],
  // so 1 and 2 are the two halves of its only change.
  const HUNK = parseDiffHunks(DIFF)[0];

  it("stages only the lines picked out of the hunk", async () => {
    await mountWithOpenDiff();
    // Until something is picked the header offers the hunk and nothing finer.
    expect(screen.queryByText(/Stage \d+ line/)).toBeNull();

    fireEvent.click(screen.getByText("-two"));
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 2 lines")).toBeTruthy());
    expect(applyLineArgs, "picking a line must not apply anything on its own").toEqual([]);

    fireEvent.click(screen.getByText("Stage 2 lines"));
    await waitFor(() => expect(applyLineArgs).toHaveLength(1));
    // The indices are only meaningful against the body they were picked from,
    // so the fingerprint of that exact hunk travels with them.
    expect(applyLineArgs[0]).toMatchObject({
      projectPath: "/proj",
      file: "src/a.ts",
      hunkIndex: 0,
      fingerprint: hunkFingerprint(HUNK.header, HUNK.lines),
      lines: [1, 2],
      reverse: false,
    });
  });

  it("counts one line as one, and drops the control when the last is unpicked", async () => {
    await mountWithOpenDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.queryByText(/Stage \d+ line/)).toBeNull());
  });

  it("offers nothing to pick on an unchanged line", async () => {
    await mountWithOpenDiff();
    // Context is in both versions, so there is nothing about it to stage.
    fireEvent.click(screen.getByText("one"));
    fireEvent.click(screen.getByText("three"));
    await Promise.resolve();
    expect(screen.queryByText(/Stage \d+ line/)).toBeNull();
  });

  it("leaves the discard control acting on the whole hunk", async () => {
    // The two live in the same header, and the finer one must not quietly
    // narrow the destructive one.
    await mountWithOpenDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    fireEvent.click(screen.getByText("Discard hunk"));
    // Two now say it: the header's control and the confirm dialog's button.
    const confirm = await screen.findAllByText("Discard hunk");
    expect(confirm).toHaveLength(2);
    fireEvent.click(confirm[1]);
    await waitFor(() => expect(discardArgs).toHaveLength(1));
    expect(discardArgs[0].args).toMatchObject({ hunkIndices: [0] });
    expect(applyLineArgs).toEqual([]);
  });

  it("forgets the selection when the diff is collapsed", async () => {
    await mountWithOpenDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    // Indices into a hunk body mean nothing once that body is off screen.
    fireEvent.click(screen.getByTitle("src/a.ts"));
    await waitFor(() => expect(screen.queryByText("+TWO")).toBeNull());
    fireEvent.click(screen.getByTitle("src/a.ts"));
    await waitFor(() => expect(screen.getByText("+TWO")).toBeTruthy());
    expect(screen.queryByText(/Stage \d+ line/)).toBeNull();
  });
});

describe("discard", () => {
  /** Discard is destructive, so every path through it is confirmed. This
   *  answers the dialog and returns what the panel did next. */
  async function confirmWith(label: string) {
    fireEvent.click(await screen.findByText(label));
  }

  it("asks before discarding a file, names the recovery route, and reports it", async () => {
    const reverted: unknown[] = [];
    render(() => <ReviewPanel root="/proj" selected={null} onReverted={(o) => reverted.push(o)} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    fireEvent.click(screen.getByText("Discard"));

    // Blast radius and the way back, both stated before anything happens.
    const dialog = await screen.findByText(/1 file goes back to how it is staged/);
    expect(dialog.textContent).toContain("Undo history");
    expect(discardArgs).toEqual([]);

    await confirmWith("Discard changes");
    await waitFor(() =>
      expect(discardArgs).toEqual([
        { cmd: "git_discard_files", args: { projectPath: "/proj", files: ["src/a.ts"] } },
      ]),
    );
    // Open buffers hear about it through the channel a checkpoint revert uses,
    // so a discarded file is not silently re-saved from a stale buffer.
    await waitFor(() =>
      expect(reverted).toEqual([{ backstop_ts: 1_700_000_000, restored: ["src/a.ts"], deleted: [] }]),
    );
  });

  it("discards nothing when the confirm is declined", async () => {
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    fireEvent.click(screen.getByText("Discard"));
    await confirmWith("Cancel");

    await waitFor(() => expect(screen.queryByText("Discard changes")).toBeNull());
    expect(discardArgs).toEqual([]);
  });

  it("says it is deleting, not discarding, when the file was never committed", async () => {
    statusRows = [{ status: "??", path: "src/new.ts", staged: false, unstaged: true }];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/new.ts")).toBeTruthy());

    fireEvent.click(screen.getByText("Discard"));
    // An untracked file is not restored to anything, it is removed, and git has
    // no copy. Calling that "discard changes" would understate it.
    expect(await screen.findByText("Delete src/new.ts?")).toBeTruthy();
    await confirmWith("Delete file");
    await waitFor(() => expect(discardArgs.length).toBe(1));
  });

  it("blocks a file discard while another chat is mid-turn in the folder", async () => {
    live = [{ sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" }];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    const toasts = captureToasts();
    fireEvent.click(screen.getByText("Discard"));

    await waitFor(() => expect(toasts.messages.join(" ")).toContain("docs-agent"));
    toasts.stop();
    // Hard block: it never even got as far as asking.
    expect(screen.queryByText("Discard changes")).toBeNull();
    expect(discardArgs).toEqual([]);
  });

  it("ignores a second discard while the first one's confirm is still open", async () => {
    // The busy flag used to be set after the confirm await, leaving every
    // Discard button live behind the modal. The dialog is a singleton bound to
    // one signal, so a second click did not open a second dialog - it silently
    // *replaced* the pending one and orphaned its promise. You then answered a
    // question about b.ts believing you had answered one about a.ts.
    statusRows = [
      { status: " M", path: "src/a.ts", staged: false, unstaged: true },
      { status: " M", path: "src/b.ts", staged: false, unstaged: true },
    ];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/b.ts")).toBeTruthy());

    const [discardA, discardB] = screen.getAllByText("Discard");
    fireEvent.click(discardA);
    expect(await screen.findByText("Discard changes to src/a.ts?")).toBeTruthy();

    fireEvent.click(discardB);
    await new Promise((r) => setTimeout(r, 0));
    // Still asking about the file you actually clicked.
    expect(screen.queryByText("Discard changes to src/b.ts?")).toBeNull();
    expect(screen.getByText("Discard changes to src/a.ts?")).toBeTruthy();

    fireEvent.click(screen.getByText("Discard changes"));
    await waitFor(() =>
      expect(discardArgs).toEqual([
        { cmd: "git_discard_files", args: { projectPath: "/proj", files: ["src/a.ts"] } },
      ]),
    );
  });

  it("offers no discard on a staged row", async () => {
    statusRows = [STAGED];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByText("Staged Changes")).toBeTruthy());

    // Staged work is safe in the index, so there is nothing here to destroy.
    // Unstaging moves the row down to where discard lives.
    expect(screen.queryByText("Discard")).toBeNull();
  });
});

describe("stash", () => {
  const ENTRY = {
    selector: "stash@{0}",
    message: "fix: the thing: with colons",
    branch: "main",
    relative_date: "2 hours ago",
  };

  it("lists stashes even when the working tree is clean", async () => {
    // A clean tree hits the panel's empty state. Hiding stashes behind it would
    // lose the only route back to them at exactly the moment they matter.
    statusRows = [];
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} />);

    expect(await screen.findByText("Stashes")).toBeTruthy();
    // The message survives its colons, and is not the raw "On main: ..." subject.
    expect(screen.getByText("fix: the thing: with colons")).toBeTruthy();
  });

  it("creates a stash named after the Summary, with untracked left out by default", async () => {
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText("Summary"), { target: { value: "half-done refactor" } });

    fireEvent.click(screen.getByText("Stash all"));

    await waitFor(() =>
      expect(stashArgs).toEqual([
        {
          cmd: "git_stash_push",
          args: { projectPath: "/proj", message: "half-done refactor", includeUntracked: false },
        },
      ]),
    );
    // The name moved into the stash, so leaving it in the commit box would
    // silently seed the next commit with it.
    await waitFor(() => expect((screen.getByPlaceholderText("Summary") as HTMLInputElement).value).toBe(""));
  });

  it("passes the include-untracked flag when it is ticked", async () => {
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    fireEvent.click(screen.getByTitle(/Also stash files git has never seen/).querySelector("input")!);
    fireEvent.click(screen.getByText("Stash all"));

    await waitFor(() =>
      expect(stashArgs[0]).toEqual({
        cmd: "git_stash_push",
        args: { projectPath: "/proj", message: null, includeUntracked: true },
      }),
    );
  });

  it("says so when there was nothing to stash", async () => {
    // git exits 0 on a clean tree, so silence would read as success.
    stashCreated = false;
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    const toasts = captureToasts();
    fireEvent.click(screen.getByText("Stash all"));
    await waitFor(() => expect(toasts.messages.join(" ")).toContain("Nothing to stash"));
    toasts.stop();
  });

  it("reports an applied stash's files through onReverted", async () => {
    const reverted: unknown[] = [];
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} onReverted={(o) => reverted.push(o)} />);
    await screen.findByText("Stashes");

    fireEvent.click(screen.getByText("Pop"));

    await waitFor(() =>
      expect(stashArgs).toEqual([
        { cmd: "git_stash_apply", args: { projectPath: "/proj", selector: "stash@{0}", pop: true } },
      ]),
    );
    // A stash laid back down over an open buffer must raise the same keep-mine
    // / take-disk question a checkpoint revert does.
    await waitFor(() =>
      expect(reverted).toEqual([{ backstop_ts: null, restored: ["src/a.ts"], deleted: [] }]),
    );
  });

  it("shows git's own reason when a pop conflicts", async () => {
    stashRows = [ENTRY];
    stashFails = true;
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await screen.findByText("Stashes");

    const toasts = captureToasts();
    fireEvent.click(screen.getByText("Pop"));
    await waitFor(() => expect(toasts.messages.join(" ")).toContain("would be overwritten"));
    toasts.stop();
  });

  it("warns that dropping a stash cannot be undone from the timeline", async () => {
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await screen.findByText("Stashes");

    fireEvent.click(screen.getByText("Drop"));

    // Discard can promise a backstop; drop cannot, because a stash is not part
    // of the working tree any snapshot covers. Saying otherwise would be a lie.
    const dialog = await screen.findByText(/cannot be undone from the timeline/);
    expect(dialog.textContent).toContain("fix: the thing: with colons");
    expect(stashArgs).toEqual([]);

    fireEvent.click(screen.getByText("Drop stash"));
    await waitFor(() =>
      expect(stashArgs).toEqual([
        { cmd: "git_stash_drop", args: { projectPath: "/proj", selector: "stash@{0}" } },
      ]),
    );
  });

  it("blocks every stash action while another chat is mid-turn", async () => {
    // A stash is worktree-wide, so it can clobber an agent's in-flight work
    // just as a tree revert can.
    live = [{ sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" }];
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await screen.findByText("Stashes");

    for (const label of ["Stash all", "Apply", "Pop", "Drop"]) {
      const toasts = captureToasts();
      fireEvent.click(screen.getByText(label));
      await waitFor(() => expect(toasts.messages.join(" ")).toContain("docs-agent"));
      toasts.stop();
    }
    expect(stashArgs).toEqual([]);
    expect(screen.queryByText("Drop stash")).toBeNull();
  });
});

describe("amend", () => {
  /** Toggle amend on and wait for HEAD's message to land in the fields. */
  async function turnAmendOn() {
    const box = screen.getByTitle("Rewrite the last commit instead of adding one");
    fireEvent.click(box.querySelector("input")!);
    await waitFor(() => expect(screen.getByText("Amend")).toBeTruthy());
  }

  it("prefills the fields from HEAD and splits subject from body", async () => {
    headMsg = "previous subject\n\nprevious body\n\nsecond paragraph";
    await mountPanel();
    await turnAmendOn();

    await waitFor(() =>
      expect((screen.getByPlaceholderText("Summary") as HTMLInputElement).value).toBe("previous subject"),
    );
    expect((screen.getByPlaceholderText("Description (optional)") as HTMLTextAreaElement).value).toBe(
      "previous body\n\nsecond paragraph",
    );
  });

  it("gives back what you typed when amend is switched off again", async () => {
    headMsg = "previous subject";
    await mountPanel();
    fireEvent.input(screen.getByPlaceholderText("Summary"), { target: { value: "my own subject" } });
    await turnAmendOn();
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Summary") as HTMLInputElement).value).toBe("previous subject"),
    );

    fireEvent.click(
      screen.getByTitle("Rewrite the last commit instead of adding one").querySelector("input")!,
    );
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Summary") as HTMLInputElement).value).toBe("my own subject"),
    );
  });

  it("asks before rewriting a commit the upstream already has", async () => {
    // ahead 0 with an upstream: HEAD is contained in it.
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    headMsg = "already pushed";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByText("Amend"));

    await waitFor(() => expect(screen.getByText("Amend a pushed commit?")).toBeTruthy());
    // Nothing is committed until the question is answered.
    expect(commitArgs).toEqual([]);

    fireEvent.click(screen.getByText("Amend anyway"));
    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "already pushed", amend: true }]),
    );
  });

  it("commits nothing when the amend warning is declined", async () => {
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    headMsg = "already pushed";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByText("Amend"));

    await waitFor(() => expect(screen.getByText("Amend a pushed commit?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(screen.queryByText("Amend a pushed commit?")).toBeNull());
    expect(commitArgs).toEqual([]);
  });

  it("does not ask when there are unpushed commits on top", async () => {
    aheadBehind = { ahead: 2, behind: 0, has_upstream: true };
    headMsg = "not pushed yet";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByText("Amend"));

    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "not pushed yet", amend: true }]),
    );
    expect(screen.queryByText("Amend a pushed commit?")).toBeNull();
  });

  it("clears both fields and drops back out of amend once the commit lands", async () => {
    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    headMsg = "previous subject\n\nprevious body";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByText("Amend"));

    await waitFor(() => expect(commitArgs.length).toBe(1));
    // Back to "Commit": a successful amend is not a mode you stay in.
    await waitFor(() => expect(screen.getByText("Commit")).toBeTruthy());
    expect((screen.getByPlaceholderText("Summary") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("Description (optional)") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not ask when the branch has no upstream", async () => {
    aheadBehind = { ahead: 0, behind: 0, has_upstream: false };
    headMsg = "local only";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByText("Amend"));

    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "local only", amend: true }]),
    );
    expect(screen.queryByText("Amend a pushed commit?")).toBeNull();
  });
});

describe("the commit log entry point", () => {
  it("asks for a log tab scoped to this workspace", async () => {
    branches = [{ name: "main", current: true }];
    await mountPanel();

    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    fireEvent.click(await screen.findByTitle("Show this branch's commit log"));
    window.removeEventListener(OPEN_IN_EDITOR, listener);

    // The id carries the workspace, so the same button in another branch-unit
    // opens a different tab rather than retargeting this one.
    expect(opened).toEqual([syntheticId("log", "/proj")]);
  });
});

describe("Open PR", () => {
  /** Mount with a branch, an origin and a base, which is what the header needs
   *  before the "Open PR" button renders at all.
   *
   *  Up to date with its upstream on purpose: the compare path pushes first when
   *  the branch is ahead or unpushed, and that push waits on a `git://push-done`
   *  event no mock emits. The push itself is asserted where `push` lives. */
  async function mountWithPrHeader() {
    branches = [{ name: "wave-3", current: true }];
    defaultBase = "main";
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    await mountPanel();
    return await screen.findByText("Open PR");
  }

  it("opens the in-app form on a signed-in github.com remote", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());

    expect(await screen.findByText("Open a pull request")).toBeTruthy();
    // Prefilled from `git_default_base_branch`, and still editable: a stacked
    // branch opens against its parent, not against main.
    const base = screen.getByDisplayValue("main");
    expect(base).toBeTruthy();
  });

  it("submits the typed title and body, and names the PR it opened", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");

    fireEvent.input(screen.getByPlaceholderText("What this branch does"), {
      target: { value: "Add a thing" },
    });
    fireEvent.input(screen.getByPlaceholderText("Optional"), {
      target: { value: "Because of reasons." },
    });

    const toasts = captureToasts();
    fireEvent.click(screen.getByText("Open pull request"));

    await waitFor(() => expect(createPrArgs.length).toBe(1));
    expect(createPrArgs[0]).toEqual({
      projectPath: "/proj",
      remote: "origin",
      newPr: {
        title: "Add a thing",
        body: "Because of reasons.",
        head: "wave-3",
        base: "main",
        draft: false,
      },
    });

    // The number is the confirmation. Without it the dialog just closes, and
    // the user has no idea whether anything was opened.
    await waitFor(() => expect(toasts.messages).toContain("Opened #42"));
    toasts.stop();
    await waitFor(() => expect(screen.queryByText("Open a pull request")).toBeNull());
  });

  it("carries the draft toggle through to the backend", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");
    fireEvent.input(screen.getByPlaceholderText("What this branch does"), {
      target: { value: "Add a thing" },
    });
    fireEvent.click(screen.getByLabelText("Open as a draft"));
    fireEvent.click(screen.getByText("Open pull request"));

    await waitFor(() => expect(createPrArgs.length).toBe(1));
    expect((createPrArgs[0] as { newPr: { draft: boolean } }).newPr.draft).toBe(true);
  });

  it("keeps an edited base inside the form, so cancelling does not retarget compare", async () => {
    // The form's base is the PR's, not the repo's. Writing it back into the
    // panel's `git_default_base_branch` reading would leave a cancelled edit
    // pointing the compare-URL fallback somewhere the user never chose.
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");

    fireEvent.input(screen.getByDisplayValue("main"), { target: { value: "release" } });
    fireEvent.click(prDialog().getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Open a pull request")).toBeNull());

    // Reopening reseeds from the panel's base, so seeing "main" again is the
    // proof that the edit never reached it. The compare-URL fallback reads that
    // same value, which is what the leak would have retargeted.
    fireEvent.click(screen.getByText("Open PR"));
    await screen.findByText("Open a pull request");
    expect(screen.getByDisplayValue("main")).toBeTruthy();
    expect(screen.queryByDisplayValue("release")).toBeNull();
  });

  it("opens the PR against the edited base, not the repo default", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");

    fireEvent.input(screen.getByPlaceholderText("What this branch does"), {
      target: { value: "Add a thing" },
    });
    fireEvent.input(screen.getByDisplayValue("main"), { target: { value: "release" } });
    fireEvent.click(prDialog().getByText("Open pull request"));

    await waitFor(() => expect(createPrArgs.length).toBe(1));
    expect((createPrArgs[0] as { newPr: { base: string } }).newPr.base).toBe("release");
  });

  it("refuses to submit without a title, and says why", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");

    expect(screen.getByText("A title is required")).toBeTruthy();
    fireEvent.click(screen.getByText("Open pull request"));
    expect(createPrArgs).toEqual([]);
  });

  it("keeps the typed title and body when the server refuses", async () => {
    // Most of these failures are fixable in place, so losing the description
    // and making the user retype it would be its own insult.
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    createPrFails = { kind: "alreadyExists", message: "A pull request already exists for skarif2:wave-3." };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");
    fireEvent.input(screen.getByPlaceholderText("What this branch does"), {
      target: { value: "Add a thing" },
    });

    const toasts = captureToasts();
    fireEvent.click(screen.getByText("Open pull request"));

    // The DTO is an object, so a `String(e)` toast would read "[object Object]"
    // for every forge failure the user is meant to act on.
    await waitFor(() =>
      expect(toasts.messages).toContain("A pull request already exists for skarif2:wave-3."),
    );
    toasts.stop();
    expect(screen.getByText("Open a pull request")).toBeTruthy();
    expect((screen.getByPlaceholderText("What this branch does") as HTMLInputElement).value).toBe(
      "Add a thing",
    );
  });

  it("falls back to the compare page when signed out", async () => {
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedOut" };
    const opened: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    fireEvent.click(await mountWithPrHeader());

    await waitFor(() => expect(opened.length).toBe(1));
    expect(opened[0]).toContain("/compare/main...wave-3");
    expect(screen.queryByText("Open a pull request")).toBeNull();
    expect(createPrArgs).toEqual([]);
    open.mockRestore();
  });

  it("falls back to the compare page when the integration is switched off", async () => {
    // Signing out and switching the integration off are different things, and
    // only one of them costs the credential. Both stop the API being used.
    originUrl = "git@github.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    await saveSettings({ ...DEFAULT_SETTINGS, github: { enabled: false } });
    const opened: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    fireEvent.click(await mountWithPrHeader());

    await waitFor(() => expect(opened.length).toBe(1));
    expect(opened[0]).toContain("/compare/main...wave-3");
    expect(createPrArgs).toEqual([]);
    open.mockRestore();
  });

  it("sends GitHub Enterprise to compare rather than to a form it cannot submit", async () => {
    // prUrl's provider detection matches any host containing "github", but the
    // API client accepts github.com only. A form here would submit and come
    // back `unsupportedRemote` after the user had typed a title and body.
    originUrl = "git@github.mycorp.com:skarif2/sway.git";
    authState = { kind: "signedIn", login: "skarif2" };
    const opened: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    fireEvent.click(await mountWithPrHeader());

    await waitFor(() => expect(opened.length).toBe(1));
    expect(opened[0]).toContain("github.mycorp.com");
    expect(screen.queryByText("Open a pull request")).toBeNull();
    open.mockRestore();
  });
});

describe("the agent-drafted PR description", () => {
  it("refuses a blocked session, names the reason, and sends nothing", async () => {
    // The gate the commit-message draft goes through, applied to the same kind
    // of request. A blocked session is refused outright rather than queued: the
    // user has to answer that permission prompt first.
    branches = [{ name: "wave-3", current: true }];
    originUrl = "git@github.com:skarif2/sway.git";
    defaultBase = "main";
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    authState = { kind: "signedIn", login: "skarif2" };

    const sent: unknown[] = [];
    const onSend = (e: Event) => {
      const detail = (e as CustomEvent<{ requestId: string; text: string }>).detail;
      sent.push(detail.text);
      // Terminal.tsx answers every request; here it answers "blocked".
      window.dispatchEvent(
        new CustomEvent(SEND_TO_SESSION_RESULT, {
          detail: { requestId: detail.requestId, result: "blocked" },
        }),
      );
    };
    window.addEventListener(SEND_TO_SESSION, onSend);

    render(() => (
      <ReviewPanel
        root="/proj"
        selected={{ sessionId: "s1", agent: "claude", folderPath: "/proj" } as never}
      />
    ));
    fireEvent.click(await screen.findByText("Open PR"));
    await screen.findByText("Open a pull request");

    const toasts = captureToasts();
    fireEvent.click(prDialog().getByText("Ask agent to draft"));

    await waitFor(() => expect(toasts.messages).toContain(BLOCKED_REASON));
    toasts.stop();
    window.removeEventListener(SEND_TO_SESSION, onSend);

    // The request was composed and offered; the gate is what refused it, and
    // nothing reached the session's input.
    expect(sent.length).toBe(1);
    expect(String(sent[0])).toContain("wave-3");
    expect(String(sent[0])).toContain("main");
  });
});
