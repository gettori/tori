import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
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
let headMsg = "";
let commitArgs: unknown[] = [];

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
      case "list_branches":
        return Promise.resolve([]);
      // checkpoint_list / checkpoint_turn_files / git_ahead_behind / git_origin
      // / git_default_base_branch: the panel try/catches each one, so a null is
      // a fine stand-in for every backend call this test does not drive.
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
import { stage, refreshStatus } from "../../utils/gitActions";

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
  headMsg = "";
  commitArgs = [];
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
