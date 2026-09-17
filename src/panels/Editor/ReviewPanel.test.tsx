import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick } from "../../test/menus";
import type { FileStatus } from "../../utils/gitActions";

// The Changes panel, driven through the real component. Hunk-level staging and
// the watcher's effect on an open diff moved to DiffView.test.tsx with the diff
// itself; what is left here is the file lists, the commit box and the PR button.

// A child measures itself, and jsdom reports every width as zero, so the
// observer never has anything to say - it only has to exist.
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

const calls: { status: number; diff: number; stashList: number } = { status: 0, diff: 0, stashList: 0 };

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
let stashRows: {
  selector: string;
  sha: string;
  message: string;
  branch: string | null;
  relative_date: string;
  committed_at: number;
}[] = [];
let stashCreated = true;
let stashFails = false;
let live: { sessionId: string; sessionName: string; folderPath: string; status: string }[] = [];
// The "Open PR" button's three paths turn on these three answers, so each test
// says which world it is in rather than sharing one.
let originUrl: string | null = null;
let defaultBase: string | null = null;
let authState: { kind: string; login?: string } = { kind: "signedOut" };
// What `forge_push_and_create_pr` was called with, and what it answers. An
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
// Per-root answers, for the Topic tests: one store slot per member means one
// `git_status` per member, and a shared answer would prove nothing about which
// section is reading which slot.
let statusByRoot: Record<string, FileStatus[]> | null = null;
// Which root each backend call named. The whole point of the sectioning is that
// an action lands in the member whose row you clicked.
let statusArgs: string[] = [];
let diffArgs: { projectPath: string; file: string }[] = [];
let stageArgs: { projectPath: string; paths: string[] }[] = [];
// Which repo the checkpoint timeline read its backstops from. It has to be the
// same member the commit box is about, or the strip lists one member's history
// against another member's changes.
let backstopRoots: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "git_stage":
        stageArgs.push(args as { projectPath: string; paths: string[] });
        statusRows = [STAGED];
        return Promise.resolve(null);
      case "git_status": {
        calls.status += 1;
        const root = (args as { projectPath: string }).projectPath;
        statusArgs.push(root);
        return Promise.resolve(statusByRoot ? (statusByRoot[root] ?? []) : statusRows);
      }
      case "git_diff_text":
        calls.diff += 1;
        diffArgs.push(args as { projectPath: string; file: string });
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
      case "backstop_list":
        backstopRoots.push((args as { repoPath: string }).repoPath);
        return Promise.resolve([]);
      case "git_stash_list":
        calls.stashList += 1;
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
      case "forge_repo_account":
        return Promise.resolve(
          authState.kind === "signedOut"
            ? { kind: "noAccount", host: "github.com" }
            : { kind: "account", accountId: "personal", host: "github.com", auth: authState },
        );
      // The backend echoes back what it persisted, which is what puts the
      // settings store into agreement. Returning the default `null` would land
      // a null settings object in the store instead.
      case "set_settings":
        return Promise.resolve((args as { settings: unknown }).settings);
      case "forge_push_and_create_pr":
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
          url: "https://github.com/skarif2/tori/pull/42",
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
import { stage, stagedFiles, enterRoots, refreshStatus } from "../../utils/gitActions";
import {
  TOAST,
  OPEN_IN_EDITOR,
  SEND_TO_SESSION,
  SEND_TO_SESSION_RESULT,
  type ToastEvent,
} from "../../utils/events";
import { saveSettings, DEFAULT_SETTINGS } from "../Settings/settingsStore";
import { BLOCKED_REASON } from "../../utils/safeSend";
import { diffTabId, syntheticId } from "../../utils/syntheticTabs";
import { noteForgeAccounts, resetForgeStatusForTests } from "../../utils/forgeStatus";
import type { ForgeAccount } from "../../utils/forgeTypes";

/** Collects toast messages until `stop()`. `emitWith` is a window CustomEvent,
 *  not the Tauri event bus, so mocking the transport would never see one. */
function captureToasts() {
  const messages: string[] = [];
  const onToast = (e: Event) => messages.push((e as CustomEvent<ToastEvent>).detail.message);
  window.addEventListener(TOAST, onToast);
  return { messages, stop: () => window.removeEventListener(TOAST, onToast) };
}

/** The in-app form is offered only on a host with an account, which the sidebar
 *  loads into the forge store. */
function signInForgeAccount() {
  const account: ForgeAccount = {
    id: "personal",
    provider: "github",
    baseUrl: "https://github.com",
    login: "skarif2",
    label: "skarif2",
    expiresAt: null,
    rejectedAt: null,
    scopes: null,
    auth: authState as ForgeAccount["auth"],
  };
  noteForgeAccounts(authState.kind === "signedOut" ? [] : [account]);
}

/** The create-PR dialog's own subtree.
 *
 *  Scoped by role rather than by the title's parent: since the dialog moved onto
 *  `Dialog`, that parent is the heading row rather than the whole panel. */
function prDialog() {
  return within(screen.getByRole("dialog"));
}

/** Bring the Stashes tab up: its actions are drawn only while it is showing. */
async function showStashes() {
  fireEvent.click(await screen.findByRole("tab", { name: /^Stashes/ }));
}

/** The commit composer's one field: subject and body in a single box. */
function messageBox() {
  return screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
}

beforeEach(async () => {
  // The git store outlives any one panel, so the previous test's index would
  // otherwise still be loaded. Re-entering the root is the reset the app uses:
  // the panel fills its slot but never opens one.
  enterRoots(["/proj"]);
  statusRows = [UNSTAGED];
  calls.status = 0;
  calls.diff = 0;
  calls.stashList = 0;
  statusByRoot = null;
  statusArgs = [];
  diffArgs = [];
  stageArgs = [];
  backstopRoots = [];
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
  resetForgeStatusForTests();
  // `github` is named explicitly rather than left to the spread: the settings
  // store is created *over* DEFAULT_SETTINGS, so writing to the store mutates
  // that object in place. A test that switches the integration off leaves
  // `DEFAULT_SETTINGS.github.enabled === false` behind it, and a reset that
  // spreads the same object would faithfully restore the wrong value.
  await saveSettings({ ...DEFAULT_SETTINGS, forge: { enabled: true, picks: {} } });
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

describe("a11y", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    // Inline rather than portalled, so the panel's own container is the scope.
    await expectNoAxeViolations(container);
  });

  it("keeps the row controls named, and stops emitting a native title", async () => {
    await mountPanel();

    // The row's controls are icon-only, so each carries a short `aria-label`
    // and keeps the sentence for its tooltip. Both halves are asserted, because
    // the failure this risks is a control that looks right and answers to
    // nothing.
    const copy = screen.getAllByRole("button", { name: "Copy diff" });
    expect(copy.length).toBeGreaterThan(0);
    expect(copy[0].getAttribute("title")).toBeNull();
  });
});

describe("the shared git store", () => {
  it("moves a file to Staged when something outside the panel stages it", async () => {
    // What the command palette's "Stage this file" runs. The panel used to hold
    // its own `git_status` signal, so an action from anywhere else left it
    // showing the file as unstaged until something happened to refresh it.
    await mountPanel();
    expect(screen.queryByText("Staged Changes")).toBeNull();
    // The unstaged group is the only group, so it draws no header of its own.
    expect(screen.queryByText("Changes")).toBeNull();

    await stage("/proj", ["src/a.ts"]);

    await waitFor(() => expect(screen.getByText("Staged Changes")).toBeTruthy());
    // The unstaged group left with its last row, so there is still no header.
    expect(screen.queryByText("Changes")).toBeNull();
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
    const rows = screen.getAllByRole("button", { name: /src\/c\.ts/ });
    expect(rows).toHaveLength(1);
    // The row is the control, so it is a button: opening the file is its main
    // action, and a div would make the whole section mouse-only. Nothing is
    // nested inside it - stage, unstage and discard are all refused here, and
    // the one action it does have sits beside it, since a button inside a
    // button is not clickable in its own right.
    expect(rows[0].tagName).toBe("BUTTON");
    expect(rows[0].querySelectorAll("button")).toHaveLength(0);
    // The ordinary file beside it still gets its group and its controls, so the
    // conflict group is an addition rather than a takeover. With Conflicts above
    // it, the unstaged group names itself.
    expect(screen.getAllByText("Changes")).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: /src\/c\.ts/ }));
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
    // The refusal moved from `title` to the tooltip, which a disabled button
    // cannot open by itself - hence `tooltipWhenDisabled` around it.
    fireEvent.pointerEnter(ask.closest("[data-tooltip-hover-surface]")!);
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toBe("Select a session first"),
    );
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

    await showStashes();
    const stashAll = () => screen.getByRole<HTMLButtonElement>("button", { name: "Stash all" });
    expect(stashAll().disabled).toBe(true);
    // Reached through the hover surface, since a disabled button fires no
    // pointer events of its own.
    fireEvent.pointerEnter(stashAll().closest("[data-tooltip-hover-surface]")!);
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toMatch(/merge is unresolved/),
    );

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

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await confirmWith("Cancel");

    await waitFor(() => expect(screen.queryByText("Discard changes")).toBeNull());
    expect(discardArgs).toEqual([]);
  });

  it("says it is deleting, not discarding, when the file was never committed", async () => {
    statusRows = [{ status: "??", path: "src/new.ts", staged: false, unstaged: true }];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/new.ts")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

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

    const [discardA, discardB] = screen.getAllByRole("button", { name: "Discard" });
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
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});

describe("stash", () => {
  const ENTRY = {
    selector: "stash@{0}",
    sha: "c0ffee0000000000000000000000000000000000",
    committed_at: 1_700_000_000,
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

    await showStashes();
    // The message survives its colons, and is not the raw "On main: ..." subject.
    expect(await screen.findByText("fix: the thing: with colons")).toBeTruthy();
  });

  it("creates a stash named after the message's first line, untracked left out by default", async () => {
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText("Message"), {
      target: { value: "half-done refactor\n\nthe rest of it" },
    });

    await showStashes();
    fireEvent.click(screen.getByRole("button", { name: "Stash all" }));

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
    await waitFor(() => expect(messageBox().value).toBe(""));
  });

  it("passes the include-untracked flag when it is ticked", async () => {
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());

    await showStashes();
    fireEvent.click(screen.getByLabelText("untracked"));
    fireEvent.click(screen.getByRole("button", { name: "Stash all" }));

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
    await showStashes();

    const toasts = captureToasts();
    fireEvent.click(screen.getByRole("button", { name: "Stash all" }));
    await waitFor(() => expect(toasts.messages.join(" ")).toContain("Nothing to stash"));
    toasts.stop();
  });

  it("reports an applied stash's files through onReverted", async () => {
    const reverted: unknown[] = [];
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} onReverted={(o) => reverted.push(o)} />);
    await showStashes();

    fireEvent.click(await screen.findByRole("button", { name: "Pop stash" }));

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
    await showStashes();

    const toasts = captureToasts();
    fireEvent.click(await screen.findByRole("button", { name: "Pop stash" }));
    await waitFor(() => expect(toasts.messages.join(" ")).toContain("would be overwritten"));
    toasts.stop();
  });

  it("warns that dropping a stash cannot be undone from the timeline", async () => {
    stashRows = [ENTRY];
    render(() => <ReviewPanel root="/proj" selected={null} />);
    await showStashes();

    fireEvent.click(await screen.findByRole("button", { name: "Drop stash" }));

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
    await showStashes();

    for (const label of ["Stash all", "Apply stash", "Pop stash", "Drop stash"]) {
      const toasts = captureToasts();
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(toasts.messages.join(" ")).toContain("docs-agent"));
      toasts.stop();
    }
    expect(stashArgs).toEqual([]);
    expect(screen.queryByText("Drop this stash?")).toBeNull();
  });
});

describe("amend", () => {
  /** Amend lives in the Commit button's own menu, so switching it is two
   *  clicks: open the split button's menu, then pick the row. */
  async function flipAmend(row: "Commit (Amend)" | "Stop amending") {
    pointerClick(screen.getByRole("button", { name: "More commit actions" }));
    const item = await screen.findByRole("menuitem", { name: row });
    pointerClick(item);
    // The menu closes a macrotask after the pick. A trigger pressed before that
    // toggles the closing menu shut instead of opening a fresh one.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }

  /** Toggle amend on and wait for HEAD's message to land in the fields. */
  async function turnAmendOn() {
    await flipAmend("Commit (Amend)");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Amend/ })).toBeTruthy());
  }

  it("prefills the message box from HEAD, paragraph breaks and all", async () => {
    headMsg = "previous subject\n\nprevious body\n\nsecond paragraph";
    await mountPanel();
    await turnAmendOn();

    await waitFor(() =>
      expect(messageBox().value).toBe("previous subject\n\nprevious body\n\nsecond paragraph"),
    );
  });

  it("gives back what you typed when amend is switched off again", async () => {
    headMsg = "previous subject";
    await mountPanel();
    fireEvent.input(screen.getByPlaceholderText("Message"), { target: { value: "my own subject" } });
    await turnAmendOn();
    await waitFor(() => expect(messageBox().value).toBe("previous subject"));

    await flipAmend("Stop amending");
    await waitFor(() => expect(messageBox().value).toBe("my own subject"));
  });

  it("asks before rewriting a commit the upstream already has", async () => {
    // ahead 0 with an upstream: HEAD is contained in it.
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    headMsg = "already pushed";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    await waitFor(() => expect(screen.getByText("Amend a pushed commit?")).toBeTruthy());
    // Nothing is committed until the question is answered.
    expect(commitArgs).toEqual([]);

    fireEvent.click(screen.getByText("Amend anyway"));
    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "already pushed", amend: true, signoff: false }]),
    );
  });

  it("commits nothing when the amend warning is declined", async () => {
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    headMsg = "already pushed";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "not pushed yet", amend: true, signoff: false }]),
    );
    expect(screen.queryByText("Amend a pushed commit?")).toBeNull();
  });

  it("clears the message and drops back out of amend once the commit lands", async () => {
    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    headMsg = "previous subject\n\nprevious body";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    await waitFor(() => expect(commitArgs.length).toBe(1));
    // Back to "Commit": a successful amend is not a mode you stay in.
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy());
    expect(messageBox().value).toBe("");
  });

  it("does not ask when the branch has no upstream", async () => {
    aheadBehind = { ahead: 0, behind: 0, has_upstream: false };
    headMsg = "local only";
    await mountPanel();
    await turnAmendOn();
    fireEvent.click(screen.getByRole("button", { name: "Amend" }));

    await waitFor(() =>
      expect(commitArgs).toEqual([{ projectPath: "/proj", message: "local only", amend: true, signoff: false }]),
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
    pointerClick(screen.getByRole("button", { name: "More Actions" }));
    pointerClick(await screen.findByRole("menuitem", { name: "Show Commit Log" }));

    // The id carries the workspace, so the same entry in another branch-unit
    // opens a different tab rather than retargeting this one.
    await waitFor(() => expect(opened).toEqual([syntheticId("log", "/proj")]));
    window.removeEventListener(OPEN_IN_EDITOR, listener);
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
    signInForgeAccount();
    await mountPanel();
    return await screen.findByRole("button", { name: "Open PR" });
  }

  it("opens the in-app form on a signed-in github.com remote", async () => {
    originUrl = "git@github.com:skarif2/tori.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());

    expect(await screen.findByText("Open a pull request")).toBeTruthy();
    // Prefilled from `git_default_base_branch`, and still editable: a stacked
    // branch opens against its parent, not against main.
    const base = screen.getByDisplayValue("main");
    expect(base).toBeTruthy();
  });

  it("submits the typed title and body, and names the PR it opened", async () => {
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
    authState = { kind: "signedIn", login: "skarif2" };
    fireEvent.click(await mountWithPrHeader());
    await screen.findByText("Open a pull request");

    fireEvent.input(screen.getByDisplayValue("main"), { target: { value: "release" } });
    fireEvent.click(prDialog().getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Open a pull request")).toBeNull());

    // Reopening reseeds from the panel's base, so seeing "main" again is the
    // proof that the edit never reached it. The compare-URL fallback reads that
    // same value, which is what the leak would have retargeted.
    fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    await screen.findByText("Open a pull request");
    expect(screen.getByDisplayValue("main")).toBeTruthy();
    expect(screen.queryByDisplayValue("release")).toBeNull();
  });

  it("opens the PR against the edited base, not the repo default", async () => {
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
    authState = { kind: "signedIn", login: "skarif2" };
    await saveSettings({ ...DEFAULT_SETTINGS, forge: { enabled: false, picks: {} } });
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
    originUrl = "git@github.mycorp.com:skarif2/tori.git";
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
    originUrl = "git@github.com:skarif2/tori.git";
    defaultBase = "main";
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    authState = { kind: "signedIn", login: "skarif2" };
    signInForgeAccount();

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
    fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
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

// The Topic path: one member on screen at a time, picked by the chips in row
// one, the same way the file tree does it. What is asserted here is that every
// surface below follows the chip, and that a click never reaches the member
// beside the one showing.
describe("inside a Topic", () => {
  const A = "/feat/api";
  const B = "/feat/web";
  const READY = { label: "Ready", usable: true, action: null, reason: null };
  const MEMBERS = [
    { path: A, repoPath: "/r/api", label: "api", tint: "200", state: READY },
    { path: B, repoPath: "/r/web", label: "web", state: READY },
  ];

  /** The chips take the tinted member list, the same one the file tree draws. */
  const chipsFor = (roots: typeof MEMBERS) =>
    roots.map((r, order) => ({
      member: {
        repoPath: r.repoPath,
        displayName: r.label,
        worktreePath: r.path,
        state: { kind: "present" },
        order,
      },
      key: r.path,
      label: r.label,
      state: r.state,
      hue: r.tint,
      style: undefined,
    }));

  const chip = (label: string) => screen.getByRole("button", { name: label });
  /** The one member's list on screen. */
  const shownRoot = () => document.querySelector("[data-root]")!.getAttribute("data-root");

  /** Mount over two members, each with its own single unstaged file. */
  async function mountTopic(roots = MEMBERS) {
    statusByRoot = {
      [A]: [{ status: " M", path: "src/index.ts", staged: false, unstaged: true }],
      [B]: [{ status: " M", path: "src/index.ts", staged: false, unstaged: true }],
    };
    enterRoots([A, B], A);
    render(() => (
      <ReviewPanel root={A} roots={roots as never} members={chipsFor(roots) as never} selected={null} />
    ));
    await waitFor(() => expect(document.querySelector("[data-root]")).toBeTruthy());
    // The panel registers its listeners from an async `onMount`; a test that
    // fires a burst or a focus before that would be testing nothing.
    await waitFor(() => expect(handlers["fs://changed"]?.length).toBeGreaterThan(1));
    return roots;
  }

  it("has no accessibility violations with a member on screen", async () => {
    statusByRoot = {
      [A]: [{ status: " M", path: "src/index.ts", staged: false, unstaged: true }],
      [B]: [{ status: "UU", path: "src/index.ts", staged: false, unstaged: false, conflicted: true }],
    };
    enterRoots([A, B], A);
    const { container } = render(() => (
      <ReviewPanel root={A} roots={MEMBERS as never} members={chipsFor(MEMBERS) as never} selected={null} />
    ));
    await waitFor(() => expect(document.querySelector("[data-root]")).toBeTruthy());

    await expectNoAxeViolations(container);
  });

  it("draws a chip per member but only one member's changes", async () => {
    await mountTopic();

    // Both chips, in member order, named so a screen reader can pick one.
    expect(chip("api")).toBeTruthy();
    expect(chip("web")).toBeTruthy();
    // One list, not two: a stack of every member's changes is what this
    // replaced.
    expect(document.querySelectorAll("[data-root]")).toHaveLength(1);
    expect(shownRoot()).toBe(A);
    expect(screen.getAllByTitle("src/index.ts")).toHaveLength(1);
    expect(chip("api").getAttribute("aria-pressed")).toBe("true");
    expect(chip("web").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches the whole panel when another chip is pressed", async () => {
    await mountTopic();

    fireEvent.click(chip("web"));

    await waitFor(() => expect(shownRoot()).toBe(B));
    expect(chip("web").getAttribute("aria-pressed")).toBe("true");
    expect(chip("api").getAttribute("aria-pressed")).toBe("false");
  });

  it("draws no chips row outside a Topic", async () => {
    await mountPanel();

    expect(screen.queryByRole("group", { name: "Topic members" })).toBeNull();
  });

  // A member rename and a member reorder arrive as a new `roots` prop: the
  // commands emit, the shared resource refetches, and the panel is handed a new
  // array. What is pinned here is that the chips follow it.
  it("follows a renamed and reordered members prop", async () => {
    const [roots, setRoots] = createSignal(MEMBERS);
    statusByRoot = {
      [A]: [{ status: " M", path: "src/index.ts", staged: false, unstaged: true }],
      [B]: [{ status: " M", path: "src/index.ts", staged: false, unstaged: true }],
    };
    enterRoots([A, B], A);
    render(() => (
      <ReviewPanel
        root={A}
        roots={roots() as never}
        members={chipsFor(roots()) as never}
        selected={null}
      />
    ));
    await waitFor(() => expect(chip("api")).toBeTruthy());

    setRoots([{ ...MEMBERS[1], label: "Storefront" }, MEMBERS[0]]);

    await waitFor(() => expect(chip("Storefront")).toBeTruthy());
    expect(chip("api")).toBeTruthy();
  });

  it("discards in the member on screen, and leaves the other alone", async () => {
    await mountTopic();
    fireEvent.click(chip("web"));
    await waitFor(() => expect(shownRoot()).toBe(B));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const confirm = await screen.findByText("Discard changes");
    fireEvent.click(confirm);

    await waitFor(() => expect(discardArgs).toHaveLength(1));
    expect(discardArgs[0].args).toMatchObject({ projectPath: B, files: ["src/index.ts"] });
  });

  it("stages every change in the member on screen, and only that member", async () => {
    await mountTopic();
    fireEvent.click(chip("web"));
    await waitFor(() => expect(shownRoot()).toBe(B));

    pointerClick(screen.getByRole("button", { name: "More Actions" }));
    pointerClick(await screen.findByRole("menuitem", { name: "Stage All Changes" }));

    await waitFor(() => expect(stageArgs).toHaveLength(1));
    expect(stageArgs[0]).toMatchObject({ projectPath: B, paths: ["src/index.ts"] });
  });

  it("opens the diff tab of the member on screen", async () => {
    await mountTopic();
    fireEvent.click(chip("web"));
    await waitFor(() => expect(shownRoot()).toBe(B));

    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(OPEN_IN_EDITOR, listener);
    fireEvent.click(screen.getByTitle("src/index.ts"));
    window.removeEventListener(OPEN_IN_EDITOR, listener);

    // Two members share this relative path, so the id carrying the workspace is
    // the only thing keeping them apart.
    expect(opened).toEqual([diffTabId(B, "src/index.ts", false)]);
  });

  it("reads the branch, ahead/behind and Open PR from the member on screen", async () => {
    branches = [{ name: "feat/auth", current: true }];
    aheadBehind = { ahead: 2, behind: 0, has_upstream: true };
    originUrl = "git@github.com:o/r.git";
    defaultBase = "main";
    await mountTopic();

    // Escaped rather than literal so this file stays ASCII, same as the panel.
    const PILL = "\u21912";
    // One of each: they are one repo's answers, and the chip says which repo.
    await waitFor(() => expect(screen.getAllByText(PILL)).toHaveLength(1));
    expect(screen.getAllByText("feat/auth")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Open PR" })).toHaveLength(1),
    );
  });

  it("says a member cannot be opened instead of listing files for it", async () => {
    const BROKEN = [
      MEMBERS[0],
      {
        path: "/r/web",
        repoPath: "/r/web",
        label: "web",
        state: { label: "Worktree missing", usable: false, action: "recreate", reason: null },
      },
    ];
    statusByRoot = { [A]: [], "/r/web": [] };
    enterRoots([A, "/r/web"], A);
    render(() => (
      <ReviewPanel root={A} roots={BROKEN as never} members={chipsFor(BROKEN as never) as never} selected={null} />
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: /web/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /web/ }));

    // The reason reads out rather than hiding in a title: it is the only
    // account of why this member has nothing to show.
    await waitFor(() => expect(screen.getByText("Worktree missing")).toBeTruthy());
    expect(screen.getByText("Recreate")).toBeTruthy();
    expect(screen.queryByTitle("src/index.ts")).toBeNull();
  });

  it("re-reads every member on window focus, not just the one on screen", async () => {
    await mountTopic();
    statusArgs = [];

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(new Set(statusArgs)).toEqual(new Set([A, B])));
  });
});

// A Topic is one branch checked out in N repos, so one message lands in every
// member that has staged work. The chips are how that is narrowed, and amend is
// the exception that takes exactly one member.
describe("the members a Topic commits in", () => {
  const A = "/feat/api";
  const B = "/feat/web";
  const READY = { label: "Ready", usable: true, action: null, reason: null };
  const MEMBERS = [
    { path: A, repoPath: "/r/api", label: "api", tint: "200", state: READY },
    { path: B, repoPath: "/r/web", label: "web", state: READY },
  ];
  const SESSION = { sessionId: "s1", agent: "claude", folderPath: A, sessionCwd: A };
  const STAGED_ROW = { status: "M ", path: "src/index.ts", staged: true, unstaged: false };
  const CHIPS = MEMBERS.map((r, order) => ({
    member: {
      repoPath: r.repoPath,
      displayName: r.label,
      worktreePath: r.path,
      state: { kind: "present" },
      order,
    },
    key: r.path,
    label: r.label,
    state: r.state,
    hue: r.tint,
    style: undefined,
  }));

  /** Two members with staged work unless `only` names one, and a tab open in
   *  `activePath`. */
  async function mountWithActive(
    activePath: string | null,
    selected: unknown = null,
    only?: string,
  ) {
    statusByRoot = {
      [A]: only && only !== A ? [] : [STAGED_ROW],
      [B]: only && only !== B ? [] : [STAGED_ROW],
    };
    enterRoots([A, B], A);
    render(() => (
      <ReviewPanel
        root={A}
        roots={MEMBERS as never}
        members={CHIPS as never}
        activePath={activePath}
        selected={selected as never}
      />
    ));
    // The store rather than a drawn list: with no file open the first member is
    // on screen, and it may be the one with nothing staged.
    const staged = only ? [only] : [A, B];
    await waitFor(() => expect(staged.every((r) => stagedFiles(r).length)).toBe(true));
    await waitFor(() => expect(handlers["fs://changed"]?.length).toBeGreaterThan(1));
  }

  const commitButton = () => screen.getByRole("button", { name: /^(Commit|Amend)/ });

  async function commitWith(message: string, expected: number) {
    fireEvent.input(screen.getByPlaceholderText("Message"), { target: { value: message } });
    fireEvent.click(commitButton());
    await waitFor(() => expect(commitArgs).toHaveLength(expected));
  }

  it("lands one message in every member with staged work, and says how many", async () => {
    await mountWithActive(`${B}/src/index.ts`);

    // The count is the only warning that one click writes two commits.
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit in 2 repos" })).toBeTruthy());
    await commitWith("Say what changed", 2);
    expect(commitArgs.map((c) => (c as { projectPath: string }).projectPath)).toEqual([A, B]);
    // Member order, not the order they were clicked in: the two commits are one
    // change, and the tree and search panels number the members the same way.
    expect(commitArgs.every((c) => (c as { message: string }).message === "Say what changed")).toBe(true);
  });

  it("says plain Commit when only one member has anything staged", async () => {
    await mountWithActive(null, null, B);

    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy());
    await commitWith("Say what changed", 1);
    expect(commitArgs[0]).toMatchObject({ projectPath: B });
  });

  it("leaves a member out once its chip is unticked", async () => {
    await mountWithActive(`${A}/src/index.ts`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit in 2 repos" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Leave web out of this commit" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy());
    await commitWith("Say what changed", 1);
    expect(commitArgs[0]).toMatchObject({ projectPath: A });
  });

  it("draws no chips when there is nothing to pick between", async () => {
    // One member staged is not a choice, and a row of one chip would only ask a
    // question with a single answer.
    await mountWithActive(null, null, A);

    expect(screen.queryByRole("button", { name: /out of this commit$/ })).toBeNull();
  });

  it("names the drafted paths the way the session can resolve them", async () => {
    // The agent is running in A. A bare "src/index.ts" would name A's file
    // while meaning B's, so the mention goes out absolute instead. Only B is
    // staged, so B is the repo the draft is about.
    await mountWithActive(`${B}/src/index.ts`, SESSION, B);
    const sent: { text: string }[] = [];
    const onSend = (e: Event) => sent.push((e as CustomEvent<{ text: string }>).detail);
    window.addEventListener(SEND_TO_SESSION, onSend);

    fireEvent.click(screen.getByText("AI Draft"));
    await waitFor(() => expect(sent).toHaveLength(1));
    window.removeEventListener(SEND_TO_SESSION, onSend);

    expect(sent[0].text).toContain(`${B}/src/index.ts`);
  });

  it("points the checkpoint strip at the member the file in front lives in", async () => {
    await mountWithActive(`${B}/src/index.ts`, SESSION);

    // Both of the strip's roots move together: a `root` that followed the file
    // while `folderPath` stayed would list A's sessions over B's checkpoints.
    await waitFor(() => expect(backstopRoots).toContain(B));
    expect(backstopRoots).not.toContain(A);
  });
});
