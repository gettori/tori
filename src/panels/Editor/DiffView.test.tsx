import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import type { FileStatus } from "../../utils/gitActions";
import { tintedMember } from "../../utils/topicMembers";

// The diff tab, driven through the real component. Two things are its own and
// nothing else's: which watcher bursts make it refetch (refetching drops the
// gaps the user expanded, so "refetch on everything" is a bug, not a
// conservative default), and that a line selection only ever applies against
// the hunk body it was picked from.

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

const UNSTAGED = { status: " M", path: "src/a.ts", staged: false, unstaged: true };

let diffCalls = 0;
let diffArgs: { projectPath: string; file: string; mode?: string }[] = [];
let statusRows: FileStatus[] = [UNSTAGED];
// What a line-level stage asked for. The indices only mean anything alongside
// the fingerprint they were picked against, so both are recorded.
let applyLineArgs: unknown[] = [];
let applyHunkArgs: unknown[] = [];
let discardArgs: { cmd: string; args: unknown }[] = [];
let diffText = DIFF;
let fileLines = ["one", "TWO", "three"];

// Rows are read by their text here, and a painted row splits its text into
// token spans. Colour is DiffRows' business and tested there, so no language.
vi.mock("./syntaxLines", () => ({ languageForPath: async () => null, tokenLines: () => [] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "git_diff_text":
        diffCalls += 1;
        diffArgs.push(args as { projectPath: string; file: string; mode?: string });
        return Promise.resolve(diffText);
      case "git_file_slice":
        return Promise.resolve(fileLines);
      case "git_status":
        return Promise.resolve(statusRows);
      case "git_apply_hunks":
        applyHunkArgs.push(args);
        return Promise.resolve(null);
      case "git_apply_lines":
        applyLineArgs.push(args);
        return Promise.resolve(null);
      case "git_discard_hunks":
        discardArgs.push({ cmd, args });
        return Promise.resolve({ backstop_ts: 1_700_000_000, restored: ["src/a.ts"], deleted: [] });
      // list_branches / git_ahead_behind / git_head_sha: the store try/catches
      // each one, so a null is a fine stand-in for every call this test does
      // not drive.
      default:
        return Promise.resolve(null);
    }
  },
}));

const handlers: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import { EditorView } from "@codemirror/view";
import DiffView from "./DiffView";
import { writeDiffEditorLayout } from "../../utils/diffLayout";
import { parseDiffHunks } from "../../utils/diffHunks";
import { pathCrumbs } from "./breadcrumbTrail";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { enterRoots } from "../../utils/gitActions";
import { diffTabId, parseDiffArg } from "../../utils/syntheticTabs";

/** One watcher burst, delivered to every registered `fs://changed` listener.
 *  The backend always names the root it happened in, and the view matches on
 *  it: a burst in one member must not refetch another member's diff. */
function fsBurst(paths: string[], root = "/proj") {
  for (const fn of handlers["fs://changed"] ?? []) fn({ payload: { root, paths } });
}

beforeEach(() => {
  // The git store outlives any one view, so the previous test's index would
  // otherwise still be loaded.
  enterRoots(["/proj"]);
  statusRows = [UNSTAGED];
  diffCalls = 0;
  diffArgs = [];
  applyLineArgs = [];
  applyHunkArgs = [];
  discardArgs = [];
  diffText = DIFF;
  fileLines = ["one", "TWO", "three"];
  writeDiffEditorLayout(false);
  for (const key of Object.keys(handlers)) delete handlers[key];
});

/** Mount on the unstaged half of `src/a.ts`, one diff fetch spent. */
async function mountDiff(staged = false) {
  render(() => <DiffView workspace="/proj" arg={`${staged ? "staged" : "unstaged"}:src/a.ts`} selected={null} />);
  await waitFor(() => expect(diffCalls).toBe(1));
  await waitFor(() => expect(screen.getByText("+TWO")).toBeTruthy());
}

describe("the tab id", () => {
  it("keeps a file's two comparisons apart", () => {
    // A partially staged file has both open at once, and they are different
    // documents: every fingerprint below is derived against one of them.
    expect(diffTabId("/proj", "src/a.ts", true)).not.toBe(diffTabId("/proj", "src/a.ts", false));
    expect(parseDiffArg("staged:src/a.ts")).toEqual({ file: "src/a.ts", staged: true });
    expect(parseDiffArg("unstaged:src/a.ts")).toEqual({ file: "src/a.ts", staged: false });
  });

  it("reads a bare path as the working tree", () => {
    // What a path with no prefix meant before the arg carried one.
    expect(parseDiffArg("src/a.ts")).toEqual({ file: "src/a.ts", staged: false });
  });

  it("splits on the first colon only, so a path may contain one", () => {
    expect(parseDiffArg("staged:src/od:d.ts")).toEqual({ file: "src/od:d.ts", staged: true });
  });
});

describe("which comparison it asks for", () => {
  it("asks the backend for the half its id names", async () => {
    await mountDiff(true);
    expect(diffArgs[0]).toMatchObject({ projectPath: "/proj", file: "src/a.ts", mode: "staged" });
  });
});

describe("refetch", () => {
  it("refetches when a burst names this file", async () => {
    await mountDiff();
    fsBurst(["/proj/src/a.ts"]);
    await waitFor(() => expect(diffCalls).toBe(2));
  });

  it("refetches when this file rides along in a multi-path burst", async () => {
    await mountDiff();
    fsBurst(["/proj/src/other.ts", "/proj/src/a.ts", "/proj/README.md"]);
    await waitFor(() => expect(diffCalls).toBe(2));
  });

  it("ignores a burst that does not name this file", async () => {
    await mountDiff();
    fsBurst(["/proj/src/other.ts"]);
    // Nothing to wait for on a skip, so the assertion is that a turn of the
    // event loop leaves the count where it was.
    await Promise.resolve();
    expect(diffCalls).toBe(1);
  });

  it("ignores a burst in another member", async () => {
    await mountDiff();
    fsBurst(["/other/src/a.ts"], "/other");
    await Promise.resolve();
    expect(diffCalls).toBe(1);
  });
});

describe("line-level staging", () => {
  // The fixture is one hunk whose body is [" one", "-two", "+TWO", " three"],
  // so 1 and 2 are the two halves of its only change.
  const HUNK = parseDiffHunks(DIFF)[0];

  it("stages only the lines picked out of the hunk", async () => {
    await mountDiff();
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
    await mountDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.queryByText(/Stage \d+ line/)).toBeNull());
  });

  it("offers nothing to pick on an unchanged line", async () => {
    await mountDiff();
    // Context is in both versions, so there is nothing about it to stage.
    fireEvent.click(screen.getByText("one"));
    fireEvent.click(screen.getByText("three"));
    await Promise.resolve();
    expect(screen.queryByText(/Stage \d+ line/)).toBeNull();
  });

  it("leaves the discard control acting on the whole hunk", async () => {
    // The two live in the same header, and the finer one must not quietly
    // narrow the destructive one.
    await mountDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Throw away this hunk" }));
    // The header's control is an icon; the word appears once, on the confirm.
    fireEvent.click(await screen.findByText("Discard hunk"));
    await waitFor(() => expect(discardArgs).toHaveLength(1));
    expect(discardArgs[0].args).toMatchObject({ hunkIndices: [0] });
    expect(applyLineArgs).toEqual([]);
  });

  it("forgets the selection when the diff is refetched", async () => {
    await mountDiff();
    fireEvent.click(screen.getByText("+TWO"));
    await waitFor(() => expect(screen.getByText("Stage 1 line")).toBeTruthy());

    // Indices into a hunk body mean nothing once that body has changed. An
    // identical re-read sets an equal signal, which Solid does not propagate.
    diffText = DIFF.replace("+TWO", "+Two");
    fsBurst(["/proj/src/a.ts"]);
    await waitFor(() => expect(diffCalls).toBe(2));
    await waitFor(() => expect(screen.queryByText(/Stage \d+ line/)).toBeNull());
  });
});

describe("hunk staging", () => {
  const HUNK = parseDiffHunks(DIFF)[0];

  it("sends the fingerprint of the hunk as rendered", async () => {
    await mountDiff();
    fireEvent.click(screen.getByRole("button", { name: "Stage this hunk" }));
    await waitFor(() => expect(applyHunkArgs).toHaveLength(1));
    expect(applyHunkArgs[0]).toMatchObject({
      projectPath: "/proj",
      file: "src/a.ts",
      hunkIndices: [0],
      fingerprints: [hunkFingerprint(HUNK.header, HUNK.lines)],
      reverse: false,
    });
  });

  it("reverses the apply on the staged half", async () => {
    await mountDiff(true);
    fireEvent.click(screen.getByRole("button", { name: "Unstage this hunk" }));
    await waitFor(() => expect(applyHunkArgs).toHaveLength(1));
    expect(applyHunkArgs[0]).toMatchObject({ reverse: true });
  });

  it("offers no discard on the staged half", async () => {
    // A staged file's changes are safe in the index, so there is nothing here
    // to destroy.
    await mountDiff(true);
    expect(screen.queryByRole("button", { name: "Throw away this hunk" })).toBeNull();
  });
  it("offers no staging or discard in a reference member's checkout", async () => {
    const member = tintedMember(
      {
        repoPath: "/proj",
        displayName: "proj",
        mode: "reference",
        worktreePath: null,
        checkout: { path: "/proj", branch: "main", defaultBranch: "main" },
        state: { kind: "present" },
        order: 0,
      },
      [],
    );
    render(() => <DiffView workspace="/proj" arg="unstaged:src/a.ts" selected={null} member={member} />);
    await waitFor(() => expect(screen.getByText("+TWO")).toBeTruthy());
    for (const name of ["Stage this hunk", "Throw away this hunk", "Stage this file", "Discard every hunk below"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("staging from the editor layout", () => {
  const TWO_HUNKS = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,3 +10,3 @@",
    " ten",
    "-eleven",
    "+ELEVEN",
    " twelve",
    "",
  ].join("\n");

  async function remountAsBuffer(): Promise<EditorView> {
    cleanup();
    writeDiffEditorLayout(true);
    render(() => <DiffView workspace="/proj" arg="unstaged:src/a.ts" selected={null} />);
    const editor = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-editor");
      expect(el).not.toBeNull();
      return el!;
    });
    return EditorView.findFromDOM(editor)!;
  }

  it("stages the second hunk from its gutter action with the payload the rows send", async () => {
    diffText = TWO_HUNKS;
    fileLines = ["one", "TWO", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "ELEVEN", "twelve"];
    await mountDiff();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage this hunk" })[1]);
    await waitFor(() => expect(applyHunkArgs).toHaveLength(1));

    await remountAsBuffer();
    // The gutter's hidden spacer carries a copy of the buttons to size the column.
    const actions = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(
        '.cm-diff-hunk-actions .cm-gutterElement:not([style*="visibility"]) [aria-label="Stage this hunk"]',
      );
      expect(found).toHaveLength(2);
      return found;
    });
    fireEvent.click(actions[1]);
    await waitFor(() => expect(applyHunkArgs).toHaveLength(2));
    expect(applyHunkArgs[1]).toEqual(applyHunkArgs[0]);
  });

  it("stages the lines selected in the buffer with the row indices the rows send", async () => {
    await mountDiff();
    fireEvent.click(screen.getByText("-two"));
    fireEvent.click(screen.getByText("+TWO"));
    fireEvent.click(await screen.findByText("Stage 2 lines"));
    await waitFor(() => expect(applyLineArgs).toHaveLength(1));

    const view = await remountAsBuffer();
    await waitFor(() => expect(document.querySelector(".cm-diff-removed")).not.toBeNull());
    // From the end of "one", across the removed "two", to the end of "TWO".
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to, head: view.state.doc.line(2).to } });
    fireEvent.click(await screen.findByText("Stage 2 lines"));
    await waitFor(() => expect(applyLineArgs).toHaveLength(2));
    expect(applyLineArgs[1]).toEqual(applyLineArgs[0]);
  });
});

describe("the editor layout's breadcrumbs", () => {
  it("names the file the way the editor tab's trail does", async () => {
    writeDiffEditorLayout(true);
    render(() => <DiffView workspace="/proj" arg="unstaged:src/a.ts" selected={null} />);
    const bar = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    expect(bar.textContent).toBe(pathCrumbs("/proj", "/proj/src/a.ts").map((c) => c.name).join(""));
  });
});
