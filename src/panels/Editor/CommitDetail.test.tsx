import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// One commit, as an editor tab. The awkward shapes are the point: a merge whose
// diff is empty under git's own default, and a rename that reads as an addition
// unless both of its paths reach git.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/proj";
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

type File = { path: string; old_path: string | null; status: string };
type Detail = {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  relative_date: string;
  parents: string[];
  refs: string[];
  files: File[];
};

const base: Detail = {
  sha: SHA,
  short: "a1b2c3d",
  subject: "rename with edit",
  body: "",
  author: "Sk Arif",
  email: "sk@example.com",
  relative_date: "2 hours ago",
  parents: ["f".repeat(40)],
  refs: [],
  files: [],
};

let detail: Detail = base;
let detailFails = "";
let diffs: Record<string, string> = {};
let diffArgs: Record<string, unknown>[] = [];
// With `holdDetail` on, every read hangs until the test answers it by hand,
// which is the only way to have two of them genuinely in flight at once.
let holdDetail = false;
let pendingDetail: ((d: Detail) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_commit_detail":
        if (detailFails) return Promise.reject(detailFails);
        if (holdDetail) return new Promise<Detail>((resolve) => pendingDetail.push(resolve));
        return Promise.resolve(detail);
      case "git_commit_file_diff":
        diffArgs.push(args);
        return Promise.resolve(diffs[String(args.file)] ?? "");
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: CommitDetail } = await import("./CommitDetail");

function mount() {
  render(() => <CommitDetail workspace={REPO} sha={SHA} />);
}

beforeEach(() => {
  localStorage.clear();
  detail = { ...base };
  detailFails = "";
  diffs = {};
  diffArgs = [];
  holdDetail = false;
  pendingDetail = [];
});

describe("the commit detail tab", () => {
  it("shows what the commit says about itself before what it changed", async () => {
    detail = {
      ...base,
      subject: "Let a branch's history open",
      body: "The right panel is the narrow column.",
      refs: ["HEAD -> wave-2", "tag: v1"],
      files: [{ path: "src/a.ts", old_path: null, status: "M" }],
    };
    mount();

    await waitFor(() => expect(screen.getByText("Let a branch's history open")).toBeTruthy());
    expect(screen.getByText("a1b2c3d")).toBeTruthy();
    expect(screen.getByText("The right panel is the narrow column.")).toBeTruthy();
    expect(screen.getByText("HEAD -> wave-2")).toBeTruthy();
    expect(screen.getByText("Sk Arif <sk@example.com>")).toBeTruthy();
    expect(screen.getByText("2 hours ago")).toBeTruthy();
  });

  it("says a merge is shown against its first parent", async () => {
    // Otherwise the reader has no way to know why a merge of a 40-commit branch
    // lists four files: the diff is against the branch it landed on.
    detail = { ...base, subject: "merge side", parents: ["a".repeat(40), "b".repeat(40)] };
    mount();

    await waitFor(() => expect(screen.getByText(/shown against its first parent/)).toBeTruthy());
  });

  it("shows a rename as one row naming both ends", async () => {
    detail = { ...base, files: [{ path: "moved.txt", old_path: "big.txt", status: "R" }] };
    mount();

    await waitFor(() => expect(screen.getByText("big.txt → moved.txt")).toBeTruthy());
    expect(screen.getByText("renamed")).toBeTruthy();
  });

  it("hands git both paths of a rename, so its patch reads as a move", async () => {
    // The whole reason `old_path` is carried through the frontend at all:
    // pathspec-limited rename detection only pairs the two sides when both are
    // in the pathspec, and the new path alone comes back as a whole-file add.
    detail = { ...base, files: [{ path: "moved.txt", old_path: "big.txt", status: "R" }] };
    diffs["moved.txt"] = ["@@ -18,3 +18,4 @@", " 19", " 20", "+21"].join("\n");
    mount();

    fireEvent.click(await screen.findByText("big.txt → moved.txt"));

    await waitFor(() => expect(screen.getByText("+21")).toBeTruthy());
    expect(diffArgs[0]).toMatchObject({ projectPath: REPO, sha: SHA, file: "moved.txt", oldPath: "big.txt" });
  });

  it("loads a file's patch only when its row is opened, and drops it when closed", async () => {
    // A commit can touch hundreds of files and the reader wants two of them.
    detail = {
      ...base,
      files: [
        { path: "src/a.ts", old_path: null, status: "M" },
        { path: "src/b.ts", old_path: null, status: "A" },
      ],
    };
    // Deliberately unrelated lines: two that share tokens get word-level
    // highlighting, which splits the rendered line across spans.
    diffs["src/a.ts"] = ["@@ -1,2 +1,2 @@", "-alpha", "+bravo"].join("\n");
    mount();

    await waitFor(() => expect(screen.getByText("src/b.ts")).toBeTruthy());
    expect(diffArgs).toEqual([]);

    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(screen.getByText("+bravo")).toBeTruthy());
    expect(screen.getByText("-alpha")).toBeTruthy();
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeTruthy();
    expect(diffArgs.length).toBe(1);
    expect(diffArgs[0]).toMatchObject({ oldPath: undefined });

    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(screen.queryByText("+bravo")).toBeNull());
  });

  it("says a move carried no edit rather than showing an empty diff", async () => {
    // A 100% rename really has no hunks. Rendering nothing there reads as a
    // failure to load, which is the one thing it is not.
    detail = { ...base, files: [{ path: "again.txt", old_path: "moved.txt", status: "R" }] };
    diffs["again.txt"] = [
      "diff --git a/moved.txt b/again.txt",
      "similarity index 100%",
      "rename from moved.txt",
      "rename to again.txt",
    ].join("\n");
    mount();

    fireEvent.click(await screen.findByText("moved.txt → again.txt"));
    await waitFor(() => expect(screen.getByText("Moved, with no change to its contents.")).toBeTruthy());
  });

  it("shows git's own complaint when the commit cannot be read", async () => {
    detailFails = "fatal: bad object";
    mount();
    await waitFor(() => expect(screen.getByText("fatal: bad object")).toBeTruthy());
  });

  it("says plainly when a commit changed no files", async () => {
    detail = { ...base, subject: "empty commit", files: [] };
    mount();
    await waitFor(() => expect(screen.getByText("This commit changed no files.")).toBeTruthy());
  });

  it("lets the commit you switched to outrank the one still loading", async () => {
    // Switching between two commit tabs reuses this component - the tab strip
    // changes its props rather than remounting it - so the commit you left can
    // answer last and put its subject and file list under the other one's tab.
    holdDetail = true;
    const [sha, setSha] = createSignal(SHA);
    render(() => <CommitDetail workspace={REPO} sha={sha()} />);
    await waitFor(() => expect(pendingDetail.length).toBe(1));

    setSha("b".repeat(40));
    await waitFor(() => expect(pendingDetail.length).toBe(2));

    // The one it left answers last, and must not win the race it lost.
    pendingDetail[1]({ ...base, subject: "the one asked for", files: [{ path: "asked.ts", old_path: null, status: "M" }] });
    pendingDetail[0]({ ...base, subject: "the one left behind", files: [{ path: "stale.ts", old_path: null, status: "M" }] });

    await waitFor(() => expect(screen.getByText("the one asked for")).toBeTruthy());
    expect(screen.queryByText("the one left behind")).toBeNull();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });
});
