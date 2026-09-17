import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The command registry's editor and git entries land in Editor.tsx, and this is
// the arrow nothing else checks: `commands.ts` emits, the palette lists, and both
// are tested - but a handler that was never registered would leave every one of
// those tests green while the command did nothing. So this drives the events the
// palette emits and asserts what the editor actually does with them.

// The tab bar measures itself to decide what overflows; jsdom reports every
// width as zero, so the observer only has to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let statusRows: unknown[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve(statusRows);
      case "list_branches":
        return Promise.resolve([{ name: "feature", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 1, behind: 0, has_upstream: true });
      // No docs root, no restorable tabs, an empty tree: this suite opens its
      // files explicitly rather than inheriting any.
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
// `onCloseRequested` is the last thing Editor's onMount does, so it doubles as
// the signal that every listener above it is registered. Without waiting for it,
// an event fired at a still-mounting pane lands on nothing - and unlike a
// signal, an event that missed its listener is not redelivered.
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));
// CodeEditor is lazily imported and drags in all of CodeMirror. It owns the
// buffers; this suite is about the tab model and the command handlers, and it
// takes part in neither. (Its own command, EDITOR_SAVE, lands inside it.)
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { enterRoots } = await import("../../utils/gitActions");
const {
  emitWith,
  OPEN_IN_EDITOR,
  EDITOR_CLOSE_TAB,
  EDITOR_GOTO_LINE,
  GIT_STAGE_ACTIVE,
  GIT_COMMIT,
  TOAST,
} = await import("../../utils/events");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

// A Topic spanning two members, with the second one not the active member:
// the palette's git commands have to reach it anyway, since the file in front
// is what says which repo the reader means.
const MEMBER_B = "/space/other/main";
const topicSelection = {
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [REPO, MEMBER_B],
  activeRoot: REPO,
  spaceName: "",
  projectName: "Auth",
  projectPath: REPO,
  folderPath: REPO,
  branch: "feat/auth",
  projectKind: "feature",
};

let mounted: ReturnType<typeof render> | null = null;

/** Mount the pane and wait until it has read the workspace and is listening. */
async function mountEditor(sel: unknown = selection) {
  mounted = render(() => <Editor selected={sel as never} />);
  await waitFor(() => expect(invokes.some((i) => i.cmd === "git_status")).toBe(true));
  await waitFor(() => expect(listening.ready).toBe(true));
}

// jsdom measures every element as zero-wide, so OverflowTabBar folds the whole
// strip into its "+N" menu and no tab label is in the DOM to assert on. The
// pane's own empty state is the layout-independent answer to "is anything open
// in this workspace", and each command's effect is asserted through what it
// does (which file it stages, which prompt it raises) rather than through chrome.
const EMPTY_PANE = /Open a file from the tree/;

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

/** The field of the `askText` prompt with this title. Reached through the
 *  accessibility tree: since the prompt moved onto `Dialog`, the title is the
 *  panel's heading and the input is no longer a sibling of it. The role narrows
 *  it to the field, since the dialog carries the same name as its heading. */
function prompt(title: string): HTMLElement {
  return screen.getByRole("textbox", { name: title });
}

function invokedWith(cmd: string) {
  return invokes.filter((i) => i.cmd === cmd).map((i) => i.args);
}

beforeEach(async () => {
  enterRoots([]);
  localStorage.clear();
  invokes.length = 0;
  statusRows = [];
  listening.ready = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("commands the editor answers", () => {
  it("closes the active tab, leaving the one behind it active", async () => {
    await mountEditor();
    await open(`${REPO}/src/a.ts`);
    await open(`${REPO}/src/b.ts`);

    emitWith(EDITOR_CLOSE_TAB, null);

    // A clean buffer closes with no discard prompt, which is why nothing has to
    // be answered here. The pane is still showing a file, and staging now names
    // a.ts, so it is b.ts that went and a.ts that took the focus back.
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() => expect(invokedWith("git_stage")).toEqual([{ projectPath: REPO, paths: ["src/a.ts"] }]));
  });

  it("empties the pane when the last tab is closed", async () => {
    await mountEditor();
    await open(`${REPO}/src/a.ts`);

    emitWith(EDITOR_CLOSE_TAB, null);

    await waitFor(() => expect(screen.getByText(EMPTY_PANE)).toBeTruthy());
  });

  it("stages the active file by the path git wants", async () => {
    await mountEditor();
    await open(`${REPO}/src/a.ts`);

    emitWith(GIT_STAGE_ACTIVE, null);

    // Repo-relative, not the absolute path the tab is keyed by.
    await waitFor(() => expect(invokedWith("git_stage")).toEqual([{ projectPath: REPO, paths: ["src/a.ts"] }]));
  });

  it("refuses to stage a file that is not in this workspace, and says why", async () => {
    await mountEditor();
    // A Docs-tree note: a real file, opened while this workspace was selected,
    // that git here has no name for.
    await open("/elsewhere/notes.md");

    const toasts: string[] = [];
    const on = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, on);
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() => expect(toasts).toHaveLength(1));
    window.removeEventListener(TOAST, on);

    expect(toasts[0]).toContain("notes.md");
    expect(invokedWith("git_stage")).toEqual([]);
  });

  it("asks for a commit message, and commits nothing when you cancel", async () => {
    statusRows = [{ status: "M ", path: "src/a.ts", staged: true, unstaged: false }];
    await mountEditor();
    await waitFor(() => expect(invokes.some((i) => i.cmd === "git_status")).toBe(true));

    emitWith(GIT_COMMIT, null);
    await waitFor(() => expect(screen.getByText("Commit message")).toBeTruthy());

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Commit message")).toBeNull());
    expect(invokedWith("git_commit")).toEqual([]);
  });

  it("commits the message you type", async () => {
    statusRows = [{ status: "M ", path: "src/a.ts", staged: true, unstaged: false }];
    await mountEditor();

    emitWith(GIT_COMMIT, null);
    await waitFor(() => expect(screen.getByText("Commit message")).toBeTruthy());
    fireEvent.input(prompt("Commit message"), {
      target: { value: "Say what changed" },
    });
    fireEvent.click(screen.getByText("OK"));

    // The palette's one-line prompt never amends or signs off, and says so
    // rather than leaving the flags off the payload for the backend to default.
    await waitFor(() =>
      expect(invokedWith("git_commit")).toEqual([
        { projectPath: REPO, message: "Say what changed", amend: false, signoff: false },
      ]),
    );
  });

  it("does not prompt for a commit when nothing is staged", async () => {
    statusRows = [{ status: " M", path: "src/a.ts", staged: false, unstaged: true }];
    await mountEditor();

    emitWith(GIT_COMMIT, null);
    // The palette already disables the row; this is the second guard, because
    // the index can move between the row being listed and it being picked.
    await Promise.resolve();
    expect(screen.queryByText("Commit message")).toBeNull();
  });

  it("stages a file in a background member of a Feature, in that member", async () => {
    // The file in front lives in the member that is *not* active. Refusing it
    // ("isn't in this workspace") would be a refusal about a file that plainly
    // is, and staging it in the active member would stage the wrong repo.
    await mountEditor(topicSelection);
    await open(`${MEMBER_B}/src/b.ts`);

    const toasts: string[] = [];
    const on = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, on);
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() =>
      expect(invokedWith("git_stage")).toEqual([{ projectPath: MEMBER_B, paths: ["src/b.ts"] }]),
    );
    window.removeEventListener(TOAST, on);

    expect(toasts).toEqual([]);
  });

  it("commits in the member the file in front belongs to", async () => {
    statusRows = [{ status: "M ", path: "src/b.ts", staged: true, unstaged: false }];
    await mountEditor(topicSelection);
    await open(`${MEMBER_B}/src/b.ts`);

    emitWith(GIT_COMMIT, null);
    await waitFor(() => expect(screen.getByText("Commit message")).toBeTruthy());
    fireEvent.input(prompt("Commit message"), { target: { value: "Say what changed" } });
    fireEvent.click(screen.getByText("OK"));

    await waitFor(() =>
      expect(invokedWith("git_commit")).toEqual([
        { projectPath: MEMBER_B, message: "Say what changed", amend: false, signoff: false },
      ]),
    );
  });

  it("still refuses a file that is under no member at all", async () => {
    await mountEditor(topicSelection);
    await open("/elsewhere/notes.md");

    const toasts: string[] = [];
    const on = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener(TOAST, on);
    emitWith(GIT_STAGE_ACTIVE, null);
    await waitFor(() => expect(toasts).toHaveLength(1));
    window.removeEventListener(TOAST, on);

    expect(invokedWith("git_stage")).toEqual([]);
  });

  it("asks for a line number, and does nothing with a non-number", async () => {
    await mountEditor();
    await open(`${REPO}/src/a.ts`);

    emitWith(EDITOR_GOTO_LINE, null);
    await waitFor(() => expect(screen.getByText("Go to line")).toBeTruthy());
    fireEvent.input(prompt("Go to line"), { target: { value: "not a line" } });
    fireEvent.click(screen.getByText("OK"));

    // Nothing to assert on the jump itself (CodeEditor is mocked out), so what
    // is pinned is that the prompt closes rather than the handler throwing.
    await waitFor(() => expect(screen.queryByText("Go to line")).toBeNull());
  });
});
