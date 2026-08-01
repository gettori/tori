import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_status":
        calls.status += 1;
        return Promise.resolve([
          { status: " M", path: "src/a.ts", staged: false, unstaged: true },
        ]);
      case "git_diff_text":
        calls.diff += 1;
        return Promise.resolve(DIFF);
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

/** One watcher burst, delivered to every registered `fs://changed` listener. */
function fsBurst(paths: string[]) {
  for (const fn of handlers["fs://changed"] ?? []) fn({ payload: { paths } });
}

beforeEach(() => {
  calls.status = 0;
  calls.diff = 0;
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
