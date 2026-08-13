import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// Backstops are owned by the *worktree*, not by a session: a discard happens
// because the user clicked something, so there may be no chat selected at all.
// What is pinned here is that the timeline renders them on their own, which the
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
// The turn strip, empty unless a test asks for it: this suite is about the
// backstop half, which renders with no session at all.
let checkpoints: { prompt_ts: number; kind: string; file_count: number; bytes: number }[] = [];
let turnFiles: { path: string; status: string }[] = [];
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
      case "checkpoint_turn_files":
        return Promise.resolve(turnFiles);
      case "backstop_restore_tree":
        restoreArgs.push(args);
        return Promise.resolve({ restored: ["src/a.ts"], deleted: [] });
      // checkpoint_list with no session is the empty case this suite is about.
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
import { TOAST, type ToastEvent } from "../../utils/events";

beforeEach(() => {
  restoreArgs = [];
  live = [];
  checkpoints = [];
  turnFiles = [];
});

/** Collects toast messages until `stop()`. `emitWith` is a window CustomEvent,
 *  not the Tauri event bus, so mocking the transport would never see one. */
function captureToasts() {
  const messages: string[] = [];
  const onToast = (e: Event) => messages.push((e as CustomEvent<ToastEvent>).detail.message);
  window.addEventListener(TOAST, onToast);
  return { messages, stop: () => window.removeEventListener(TOAST, onToast) };
}

describe("backstop rows", () => {
  it("shows a backstop in a repo with no active session", async () => {
    render(() => <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" />);

    // The session strip is absent, and the backstop is still listed.
    expect(await screen.findByText("Discard 2 hunks in src/a.ts")).toBeTruthy();
    expect(screen.getByText("Undo history")).toBeTruthy();
    expect(screen.queryByText("Timeline")).toBeNull();
  });

  it("restores through the same channel a checkpoint revert uses", async () => {
    const reverted: unknown[] = [];
    render(() => (
      <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" onReverted={(o) => reverted.push(o)} />
    ));

    fireEvent.click(await screen.findByText("Restore"));
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
    // A backstop restore rewrites every file in the folder, exactly like
    // "Revert tree to here", so it goes through the same guard. Owning the
    // backstop does not make the other session's in-flight work ours to
    // overwrite.
    live = [{ sessionId: "other", sessionName: "docs-agent", folderPath: "/proj", status: "executing" }];
    render(() => <CheckpointTimeline root="/proj" sessionId={null} folderPath="/proj" />);

    const toasts = captureToasts();
    fireEvent.click(await screen.findByText("Restore"));

    // The refusal names who is in the way, rather than failing silently.
    await waitFor(() => expect(toasts.messages.join(" ")).toContain("docs-agent"));
    toasts.stop();
    // Hard block, so there was never a confirm to click through.
    expect(screen.queryByText("Restore files")).toBeNull();
    expect(restoreArgs).toEqual([]);
  });
});

describe("the timeline, to axe", () => {
  it("has no accessibility violations", async () => {
    // With a session, so the turn strip is on screen too: its chips are the one
    // converted control here with a role of its own (`option` inside the roving
    // listbox), and the backstop-only case would never render them.
    checkpoints = [{ prompt_ts: 1_700_000_100, kind: "turn", file_count: 1, bytes: 40 }];
    turnFiles = [{ path: "src/a.ts", status: "modified" }];
    render(() => <CheckpointTimeline root="/proj" sessionId="s1" folderPath="/proj" />);
    await screen.findByText("Timeline");
    await screen.findByText("Undo history");

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});
