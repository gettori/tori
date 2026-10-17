import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { onWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";
import { noteSetup } from "./setupToasts";

describe("noteSetup", () => {
  const offs: (() => void)[] = [];
  afterEach(() => offs.splice(0).forEach((off) => off()));

  function toasts(): ToastEvent[] {
    const seen: ToastEvent[] = [];
    offs.push(onWith<ToastEvent>(TOAST, (t) => seen.push(t)));
    return seen;
  }

  it("toasts a failure with its exit code and a Show log that opens the log", () => {
    const seen = toasts();
    const opened: OpenInEditor[] = [];
    offs.push(onWith<OpenInEditor>(OPEN_IN_EDITOR, (o) => opened.push(o)));

    noteSetup({ kind: "setup", worktree: "/p/feat", state: "failed", code: 3, log: "/logs/feat-1.log" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error", message: "Setup in feat failed (exit 3)" });
    const action = seen[0].action as { label: string; run: () => void };
    expect(action.label).toBe("Show log");
    action.run();
    expect(opened).toEqual([{ path: "/logs/feat-1.log" }]);
  });

  it("toasts a finish and stays quiet while running", () => {
    const seen = toasts();
    noteSetup({ kind: "setup", worktree: "/p/feat", state: "running", code: null, log: "/l" });
    noteSetup({ kind: "setup", worktree: "/p/feat", state: "done", code: 0, log: "/l" });
    expect(seen).toEqual([{ message: "Setup finished in feat", kind: "info" }]);
  });

  it("toasts a failed teardown with Show log and says nothing for one that finished", () => {
    const seen = toasts();
    noteSetup({ kind: "teardown", worktree: "/p/feat", state: "running", code: null, log: "/l" });
    noteSetup({ kind: "teardown", worktree: "/p/feat", state: "done", code: 0, log: "/l" });
    noteSetup({ kind: "teardown", worktree: "/p/feat", state: "failed", code: 2, log: "/l" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error", message: "Teardown in feat failed (exit 2)" });
    expect((seen[0].action as { label: string }).label).toBe("Show log");
  });

  it("toasts a run that exits on its own with a failure, and stays quiet for a stop", () => {
    const seen = toasts();
    for (const state of ["running", "stopping", "stopped"] as const) {
      noteSetup({ kind: "run", worktree: "/p/feat", state, code: null, log: "/l" });
    }
    noteSetup({ kind: "run", worktree: "/p/feat", state: "done", code: 0, log: "/l" });
    noteSetup({ kind: "run", worktree: "/p/feat", state: "failed", code: 1, log: "/l" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error", message: "Run in feat failed (exit 1)" });
    expect((seen[0].action as { label: string }).label).toBe("Show log");
  });
});
