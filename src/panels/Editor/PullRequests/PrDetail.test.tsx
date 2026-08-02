import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { PrFile, PullRequest } from "../../../utils/forgeTypes";

// One pull request's files.
//
// The two things this view exists to get right, neither of which a
// working-looking panel would show:
//
//   1. **The patch is GitHub's, not one Sway computed.** A local `git diff` of
//      the same two commits reads identically and anchors differently, and
//      Phase 10's review threads are measured against the anchors GitHub used.
//   2. **The unchanged regions are git's, not the API's.** Expanding a gap is
//      free, works on a head that was never checked out, and must never read the
//      file on disk: the right line numbers over the wrong content is the one
//      failure that looks exactly like an answer.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ROOT = "/root/work/gh";
const HEAD_SHA = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Let a pull request be read in place",
  body: null,
  state: "open",
  isDraft: false,
  author: "skarif2",
  headRef: "wave-3",
  baseRef: "main",
  headSha: HEAD_SHA,
  url: "https://github.com/skarif2/sway/pull/42",
  mergeableState: "clean",
  ...over,
});

const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/utils/forgeChip.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
  ...over,
});

// Two hunks with 36 untouched lines between them, which is what makes a gap.
const TWO_HUNKS = [
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+two edited",
  " three",
  "@@ -40,3 +40,3 @@",
  " forty",
  "-forty one",
  "+forty one edited",
  " forty two",
].join("\n");

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  files: [] as unknown[],
  truncated: false,
  fail: null as { kind: string; message: string } | null,
  slice: [] as string[],
  fetchFails: null as string | null,
  sliceFails: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "github_pr_files") {
      return bridge.fail
        ? Promise.reject(bridge.fail)
        : Promise.resolve({ items: bridge.files, truncated: bridge.truncated });
    }
    if (cmd === "git_fetch_pr_head")
      return bridge.fetchFails ? Promise.reject(bridge.fetchFails) : Promise.resolve(null);
    if (cmd === "git_blob_slice")
      return bridge.sliceFails ? Promise.reject(bridge.sliceFails) : Promise.resolve(bridge.slice);
    return Promise.resolve(null);
  },
}));

const { default: PrDetail } = await import("./PrDetail");

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

describe("the pull request detail", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.files = [];
    bridge.truncated = false;
    bridge.fail = null;
    bridge.slice = [];
    bridge.fetchFails = null;
    bridge.sliceFails = null;
    localStorage.clear();
  });

  it("renders every kind of change the API reports", async () => {
    // Four statuses, four different rows. The rename is the one that cannot be
    // inferred: without `previousPath` it reads as a new file beside a deleted
    // one, which is two changes where there was one.
    bridge.files = [
      file({ path: "src/new.ts", status: "added", additions: 9, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+const a = 1;" }),
      file({ path: "src/gone.ts", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,1 +0,0 @@\n-const b = 2;" }),
      file({ path: "src/edit.ts", status: "modified" }),
      file({
        path: "src/to.ts",
        previousPath: "src/from.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: null,
      }),
    ];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);

    await waitFor(() => expect(screen.queryByText("src/new.ts")).toBeTruthy());
    expect(screen.queryByText("src/gone.ts")).toBeTruthy();
    expect(screen.queryByText("src/edit.ts")).toBeTruthy();
    // Both halves of the rename, in one row.
    expect(screen.queryByText("src/from.ts → src/to.ts")).toBeTruthy();

    const statuses = Array.from(document.querySelectorAll("[data-file-status]")).map(
      (n) => n.getAttribute("data-file-status"),
    );
    expect(statuses).toEqual(["added", "removed", "modified", "renamed"]);

    // The patch on screen is the API's own text, byte for byte: it is what
    // Phase 10's thread anchors are measured against.
    fireEvent.click(screen.getByText("src/edit.ts"));
    expect(screen.queryByText("@@ -1,1 +1,1 @@")).toBeTruthy();
    // By `textContent`, not by text node: a matched -/+ pair is split into
    // word-level segments so the one changed token can be highlighted.
    expect(document.body.textContent).toContain("+const a = 2;");
    expect(document.body.textContent).toContain("-const a = 1;");
  });

  it("lists all forty files of a forty-file pull request", async () => {
    // The API pages at 100 and Rust walks to the ceiling; what this pins is that
    // the view renders what came back rather than slicing it to something that
    // fits on screen.
    bridge.files = Array.from({ length: 40 }, (_, i) => file({ path: `src/f${i}.ts` }));

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);

    await waitFor(() => expect(screen.queryByText("src/f0.ts")).toBeTruthy());
    expect(document.querySelectorAll("[data-file-status]")).toHaveLength(40);
    expect(screen.queryByText("src/f39.ts")).toBeTruthy();
  });

  it("expands a gap from the pull request's own head, spending no API quota", async () => {
    // The head is not checked out here, which is the normal case for reviewing
    // somebody's PR. The lines come from the commit, over git, and the request
    // count for the whole expansion is zero.
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.slice = ["line four", "line five"];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("src/edit.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/edit.ts"));

    const gap = screen.getByText(/36 unchanged lines/);
    const before = bridge.calls.length;
    fireEvent.click(gap);

    await waitFor(() => expect(screen.queryByText("line four")).toBeTruthy());
    expect(screen.queryByText("line five")).toBeTruthy();

    // The two halves of the promise. Nothing since the click touched the API,
    // and the content was read at the PR's head sha rather than off disk.
    const since = bridge.calls.slice(before);
    expect(since.filter((c) => c.cmd.startsWith("github_"))).toHaveLength(0);
    expect(cmds("git_fetch_pr_head")[0].args).toMatchObject({ number: 42, sha: HEAD_SHA });
    expect(cmds("git_blob_slice")[0].args).toMatchObject({
      rev: HEAD_SHA,
      file: "src/edit.ts",
      start: 4,
      end: 39,
    });
  });

  it("fetches the head once, however many gaps are opened", async () => {
    // A fetch per expansion would put a network round trip behind every click
    // on a file the object store already holds in full.
    bridge.files = [
      file({ path: "a.ts", patch: TWO_HUNKS }),
      file({ path: "b.ts", patch: TWO_HUNKS }),
    ];
    bridge.slice = ["line four"];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeTruthy());

    for (const path of ["a.ts", "b.ts"]) {
      fireEvent.click(screen.getByText(path));
      fireEvent.click(screen.getByText(/36 unchanged lines/));
      await waitFor(() => expect(cmds("git_blob_slice").some((c) => c.args.file === path)).toBe(true));
      fireEvent.click(screen.getByText(path));
    }
    expect(cmds("git_fetch_pr_head")).toHaveLength(1);
  });

  it("keeps the fetched head when it is the read that failed", async () => {
    // Two different failures, one cache. Forgetting the fetch because a read of
    // one path failed sends the next expansion back to the network for a commit
    // that arrived perfectly well.
    bridge.files = [file({ path: "a.ts", patch: TWO_HUNKS })];
    bridge.sliceFails = "path does not exist in 9f1c2a3";

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("a.ts"));
    fireEvent.click(screen.getByText(/36 unchanged lines/));
    await waitFor(() => expect(screen.queryByText(/path does not exist/)).toBeTruthy());

    bridge.sliceFails = null;
    bridge.slice = ["line four"];
    fireEvent.click(screen.getByText(/36 unchanged lines/));
    await waitFor(() => expect(screen.queryByText("line four")).toBeTruthy());
    expect(cmds("git_fetch_pr_head")).toHaveLength(1);
  });

  it("says so when a gap cannot be read rather than doing nothing visible", async () => {
    // A PR ref the remote will not serve, or no network at all. A click that
    // silently fails is indistinguishable from a click that missed.
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.fetchFails = "could not read from remote repository";

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("src/edit.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/edit.ts"));
    fireEvent.click(screen.getByText(/36 unchanged lines/));

    await waitFor(() =>
      expect(screen.queryByText(/could not read from remote repository/)).toBeTruthy(),
    );
    // And the gap stayed shut, rather than opening onto nothing.
    expect(screen.queryByText(/36 unchanged lines/)).toBeTruthy();
  });

  it("tells the three reasons a file shows no diff apart", async () => {
    // All three arrive as `patch: null`, and only one of them means content is
    // missing. Rendering "no changes to show" over a 4,000-line file is the
    // failure that reads as a working diff.
    bridge.files = [
      file({ path: "big.json", patch: null, additions: 3_000, deletions: 900 }),
      file({ path: "logo.png", patch: null, additions: 0, deletions: 0 }),
      file({ path: "to.ts", previousPath: "from.ts", status: "renamed", patch: null, additions: 0, deletions: 0 }),
    ];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("big.json")).toBeTruthy());

    fireEvent.click(screen.getByText("big.json"));
    expect(document.querySelector('[data-file-skip="tooLarge"]')).toBeTruthy();
    expect(screen.queryByText(/larger than the API will send/)).toBeTruthy();
    // The one skip where content is genuinely missing is the one that offers a
    // way to the content.
    const out = screen.getByText(/Read it on github.com/) as HTMLAnchorElement;
    expect(out.getAttribute("href")).toBe("https://github.com/skarif2/sway/pull/42/files");

    fireEvent.click(screen.getByText("logo.png"));
    expect(document.querySelector('[data-file-skip="noText"]')).toBeTruthy();

    fireEvent.click(screen.getByText("from.ts → to.ts"));
    expect(document.querySelector('[data-file-skip="moved"]')).toBeTruthy();
    // And the two that are complete as they stand offer none: a link out would
    // imply the reader is missing something.
    expect(screen.queryAllByText(/on github.com/)).toHaveLength(0);
  });

  it("sends the reader to github.com when the file list is capped", async () => {
    // GitHub's own ceiling, not a budget of ours. Past it the server stops
    // describing the PR, so a shorter list that looks whole is the one thing
    // this must not render.
    bridge.files = [file()];
    bridge.truncated = true;

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() =>
      expect(screen.queryByText(/more files than the API will describe/)).toBeTruthy(),
    );
    const link = screen.getByText(/See all of them on github.com/) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/skarif2/sway/pull/42/files");
  });

  it("shows the server's own sentence when the files cannot be fetched", async () => {
    bridge.fail = { kind: "rateLimited", message: "the GitHub rate limit is spent" };

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("the GitHub rate limit is spent")).toBeTruthy());
  });

  it("drops one pull request's files when another is opened", async () => {
    // The panel reuses this component rather than remounting it, so a slow
    // answer can land after the one that replaced it and put one PR's files
    // under another's number.
    bridge.files = [file({ path: "first.ts" })];
    const [current, setCurrent] = createSignal(pr({ number: 1 }));
    render(() => <PrDetail root={ROOT} pr={current()} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("first.ts")).toBeTruthy());

    bridge.files = [file({ path: "second.ts" })];
    setCurrent(pr({ number: 2 }));
    await waitFor(() => expect(screen.queryByText("second.ts")).toBeTruthy());
    expect(screen.queryByText("first.ts")).toBeNull();
  });
});
