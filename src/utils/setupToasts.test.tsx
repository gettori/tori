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

    noteSetup({ worktree: "/p/feat", state: "failed", code: 3, log: "/logs/feat-1.log" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "error", message: "Setup in feat failed (exit 3)" });
    const action = seen[0].action as { label: string; run: () => void };
    expect(action.label).toBe("Show log");
    action.run();
    expect(opened).toEqual([{ path: "/logs/feat-1.log" }]);
  });

  it("toasts a finish and stays quiet while running", () => {
    const seen = toasts();
    noteSetup({ worktree: "/p/feat", state: "running", code: null, log: "/l" });
    noteSetup({ worktree: "/p/feat", state: "done", code: 0, log: "/l" });
    expect(seen).toEqual([{ message: "Setup finished in feat", kind: "info" }]);
  });
});
