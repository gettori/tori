import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// Backstops are owned by the *worktree*, not by a session: a discard happens
// because the user clicked something, so there may be no chat selected at all.
// What is pinned here is that the list renders them on their own, which a
// session-gated version of this component could not do.

const backstops = [
  {
    ts: 1_700_000_000,
    tree: "aaa",
    worktree_path: "/proj",
    head: "cafe",
    label: "Discard 2 hunks in src/a.ts",
  },
];

let restoreArgs: unknown[] = [];
// Every `checkpoint_turn_files` call, so the range switch can be checked on
// what it actually asks the backend for.
let turnFileArgs: { cumulative?: boolean }[] = [];
// The session's turns, empty unless a test asks for them: half this suite is
// about backstops, which render with no session at all.
let checkpoints: { prompt_ts: number; kind: string; file_count: number; bytes: number }[] = [];
let turnFiles: { path: string; status: string }[] = [];
// What the cumulative read answers with, when it differs from the turn's own.
let sinceFiles: { path: string; status: string }[] | null = null;
// Who else is writing in this folder, as `folderActors` reports it.
let live: { sessionId: string; sessionName: string; folderPath: string; status: string }[] = [];

vi.mock("../../utils/sessionActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/sessionActivity")>()),
  liveSessionStatuses: () => live,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "backstop_list":
        return Promise.resolve(backstops);
      case "checkpoint_list":
        return Promise.resolve(checkpoints);
      case "checkpoint_turn_files": {
        const asked = args as { cumulative?: boolean };
        turnFileArgs.push(asked);
        return Promise.resolve(asked.cumulative ? (sinceFiles ?? turnFiles) : turnFiles);
      }
      case "backstop_restore_tree":
        restoreArgs.push(args);
        return Promise.resolve({ restored: ["src/a.ts"], deleted: [] });
      // checkpoint_sessions with no session is the empty case half this suite
      // is about.
      default:
        return Promise.resolve([]);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import CheckpointTimeline from "./CheckpointTimeline";
import { checkpointClock } from "../../utils/syntheticTabs";

beforeEach(() => {
  restoreArgs = [];
  turnFileArgs = [];
  live = [];
  checkpoints = [];
  turnFiles = [];
  sinceFiles = null;
});

const restoreButton = () => screen.findByText(`Restore tree to ${checkpointClock(1_700_000_000)}`);

describe("backstop rows", () => {
  it("shows a backstop in a repo with no active session", async () => {
    render(() => <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" />);

    // No session has a checkpoint here, and the backstop is still listed.
    expect(await screen.findByText("Discard 2 hunks in src/a.ts")).toBeTruthy();
    expect(screen.getByText("Backstops")).toBeTruthy();
    expect(screen.getByText("worktree")).toBeTruthy();
  });

  it("restores through the same channel a checkpoint revert uses", async () => {
    const reverted: unknown[] = [];
    render(() => (
      <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" onReverted={(o) => reverted.push(o)} />
    ));

    fireEvent.click(await screen.findByText("Discard 2 hunks in src/a.ts"));
    fireEvent.click(await restoreButton());
    // Destructive, so it asks first and nothing runs until it is answered.
    await waitFor(() => expect(screen.getByText(/Undo "Discard 2 hunks in src\/a.ts"\?/)).toBeTruthy());
    expect(restoreArgs).toEqual([]);

    fireEvent.click(screen.getByText("Restore files"));
    await waitFor(() => expect(restoreArgs).toEqual([{ repoPath: "/proj", ts: 1_700_000_000 }]));
    // Open buffers over a restored file have to hear about it, so the outcome
    // goes out on `onReverted` even though no backstop checkpoint was written.
    await waitFor(() =>
      expect(reverted).toEqual([{ backstop_ts: null, restored: ["src/a.ts"], deleted: [] }]),
    );
  });

  it("refuses to restore while another chat is mid-turn in the folder", async () => {
    // A backstop restore rewrites every file in the folder, exactly like a
    // tree revert, so it sits behind the same guard. Owning the backstop does
    // not make the other session's in-flight work ours to overwrite.
    live = [{ sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" }];
    render(() => <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" />);

    fireEvent.click(await screen.findByText("Discard 2 hunks in src/a.ts"));
    const button = (await restoreButton()).closest("button")!;

    // Off, so there was never a confirm to click through.
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByText("Restore files")).toBeNull();
    expect(restoreArgs).toEqual([]);
  });
});

// The range switch's whole job is to change what the turn is compared against,
// which is a flag on the files query. Both ranges are read when a turn opens,
// since each half of the switch shows its own count, so what is pinned is that
// both reads go out and that the switch decides which answer is on screen.
describe("the range switch", () => {
  const openTurn = async () => {
    checkpoints = [{ prompt_ts: 1_700_000_100, kind: "", file_count: 1, bytes: 40 }];
    turnFiles = [{ path: "src/a.ts", status: "modified" }];
    sinceFiles = [...turnFiles, { path: "src/later.ts", status: "added" }];
    render(() => <CheckpointTimeline root="/proj" sessionId="s1" folderPath="/proj" />);
    fireEvent.click(await screen.findByText("Untitled turn", { selector: "span" }));
    await screen.findByText("a.ts");
  };

  it("asks for the turn and for everything since, and lists the turn", async () => {
    await openTurn();
    expect(turnFileArgs.map((a) => a.cumulative).sort()).toEqual([false, true]);
    expect(screen.queryByText("later.ts")).toBeNull();
  });

  it("lists everything since the turn once switched, and the turn again when switched back", async () => {
    await openTurn();

    fireEvent.click(screen.getByText(/Since here/));
    expect(await screen.findByText("later.ts")).toBeTruthy();

    fireEvent.click(screen.getByText(/This turn/));
    await waitFor(() => expect(screen.queryByText("later.ts")).toBeNull());
  });
});

describe("the checkpoints, to axe", () => {
  beforeEach(() => {
    checkpoints = [{ prompt_ts: 1_700_000_100, kind: "", file_count: 1, bytes: 40 }];
    turnFiles = [{ path: "src/a.ts", status: "modified" }];
  });

  it("has no accessibility violations in the list", async () => {
    // With a session, so its turn rows are on screen beside the backstops.
    render(() => <CheckpointTimeline root="/proj" sessionId="s1" folderPath="/proj" />);
    await screen.findByText("Untitled turn", { selector: "span" });
    await screen.findByText("Backstops");

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });

  it("has no accessibility violations in a turn's detail", async () => {
    render(() => <CheckpointTimeline root="/proj" sessionId="s1" folderPath="/proj" />);
    fireEvent.click(await screen.findByText("Untitled turn", { selector: "span" }));
    await screen.findByText("a.ts");

    await expectNoAxeViolations(document.body);
  });
});
