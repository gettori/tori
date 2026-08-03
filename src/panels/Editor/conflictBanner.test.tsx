import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The conflict banner: the editor's half of the Conflicts section. Nothing in a
// buffer full of `<<<<<<<` markers says *why* it looks like that, and the
// Changes panel that does say so is on the other side of the window (and often
// closed). Both read the same store, so what is tested here is the wiring: that
// the banner tracks the open tab and the current workspace, and that it goes
// away on its own when the file stops being conflicted.
//
// It is also where the two halves meet: this mount holds the banner *and* the
// Changes panel, so it is the one place that can watch both offer "ask the
// agent to resolve" and check they ask for the same thing.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorHarness";

installResizeObserver();

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/a.ts`;
const OTHER = `${REPO}/src/b.ts`;

type Row = { status: string; path: string; staged: boolean; unstaged: boolean; conflicted?: boolean };
const CONFLICT: Row = { status: "UU", path: "src/a.ts", staged: false, unstaged: false, conflicted: true };
const RESOLVED: Row = { status: "M ", path: "src/a.ts", staged: true, unstaged: false, conflicted: false };

let statusRows: Row[] = [];

// One conflict, both sides having rewritten the same line.
const STAGES = {
  base: "one\ntwo\nthree\n",
  ours: "one\nOURS\nthree\n",
  theirs: "one\nTHEIRS\nthree\n",
  binary: false,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve(statusRows);
      // The Changes panel comes with the mount, so its own reads answer too:
      // a `null` where it expects a list is a crash, not an empty section.
      case "list_branches":
      case "fs_read_dir":
      case "git_stash_list":
      case "checkpoint_list":
      case "backstop_list":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "file_exists":
        return Promise.resolve(String(args.path) === FILE || String(args.path) === OTHER);
      case "git_conflict_stages":
        return Promise.resolve(STAGES);
      case "git_conflict_op":
        return Promise.resolve("merge");
      case "get_docs_root":
        return Promise.reject("no docs root");
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, onWith, OPEN_IN_EDITOR, SET_RIGHT_MODE, SEND_TO_SESSION, SEND_TO_SESSION_RESULT } = await import(
  "../../utils/events"
);
const { refreshStatus } = await import("../../utils/gitActions");

const selection = selectionFor(REPO);
// The same selection with a session attached: safe-send has nowhere to land
// text without one, so the ask is disabled for the banner-only tests.
const withSession = { ...selection, sessionId: "s1", agent: "claude", sessionCwd: REPO };
const BANNER = /Merge conflict/;

let mounted: ReturnType<typeof render> | null = null;

async function mountWith(path: string, sel: Partial<typeof withSession> = selection) {
  mounted = render(() => <Editor selected={sel as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

/** Stand in for Terminal.tsx: take each composed message off the bus and answer
 *  it, so the sender's await resolves instead of sitting out its own timeout. */
function collectSends(): { sent: { text: string }[]; off: () => void } {
  const sent: { text: string }[] = [];
  const off = onWith<{ requestId: string; text: string }>(SEND_TO_SESSION, (req) => {
    sent.push(req);
    emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
  });
  return { sent, off };
}

beforeEach(async () => {
  // The git store outlives any one mount, so the previous test's file list
  // would otherwise still be loaded. Selecting nothing is the app's own reset.
  await refreshStatus(null);
  statusRows = [];
  listening.ready = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the conflict banner", () => {
  it("is up as soon as a conflicted file is opened", async () => {
    statusRows = [CONFLICT];
    await mountWith(FILE);

    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());
  });

  it("clears itself once the file is marked resolved", async () => {
    // `git add` on an unmerged path is what marking resolved means. The banner
    // watches the store rather than the buffer, so it goes on the next status
    // read - no save, no reopen, and nothing for the resolve path to remember.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    statusRows = [RESOLVED];
    await refreshStatus(REPO);

    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
  });

  it("opens the three-way view for the file it is about", async () => {
    // The banner says the file holds both sides; the button is the only route
    // to seeing what those sides are. A tab rather than a pane, so the file
    // itself stays open beside it.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    fireEvent.click(screen.getByText("Compare the versions"));

    // Named after the file, and repo-relative: the id carries the workspace
    // separately, so a path from another worktree cannot address this one.
    // `getAllBy`, because the tab strip renders a hidden ghost copy of itself
    // to measure against.
    await waitFor(() => expect(screen.getAllByText("Conflict: a.ts").length).toBeGreaterThan(0));
  });

  it("stays off a file that is not the conflicted one", async () => {
    // The store lists paths, not the open file, so a banner that only asked
    // "is anything conflicted" would sit on every tab in the workspace.
    statusRows = [CONFLICT];
    await mountWith(OTHER);

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("asks the agent for the same thing from the banner and from the Conflicts row", async () => {
    // Two entry points, one question. They are separate components reading
    // separate state (the banner knows the open tab, the row knows a path in a
    // list), so the only thing keeping their wording together is that both go
    // through the one composer - which is what this asserts, byte for byte.
    statusRows = [CONFLICT];
    await mountWith(FILE, withSession);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());
    const { sent, off } = collectSends();

    fireEvent.click(screen.getByText("Ask agent to resolve"));
    await waitFor(() => expect(sent).toHaveLength(1));

    // The same file, reached the other way: as a row in the Changes panel's
    // Conflicts section, which never opened it.
    emitWith(SET_RIGHT_MODE, { mode: "changes" });
    await waitFor(() => expect(screen.getByText("Ask agent")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask agent"));
    await waitFor(() => expect(sent).toHaveLength(2));
    off();

    expect(sent[1].text).toBe(sent[0].text);
    expect(sent[0].text).toContain("Resolve the conflict in @src/a.ts");
    // Insert-only: what lands at the prompt is one line, so nothing submits
    // halfway through it.
    expect(sent[0].text).not.toMatch(/\n/);
  });

  it("says why the ask is refused when no session is selected", async () => {
    // Safe-send needs somewhere to land the text. The banner keeps its own copy
    // of that gate (it is not inside a panel that already has one), so it is
    // worth checking it actually refuses rather than sending into nothing.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    const ask = screen.getByText("Ask agent to resolve").closest("button") as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toBe("Select a session first");
  });

  it("says nothing while the store describes another workspace", async () => {
    // The store blanks and refills on a workspace switch, so between the two
    // its file list belongs to the workspace being left. Answering from it
    // would flag a file here because a file *there* is conflicted.
    statusRows = [CONFLICT];
    await mountWith(FILE);
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());

    await refreshStatus("/space/proj/other");

    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
  });
});
