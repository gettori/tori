// What the window's close handler does with unsaved buffers.
//
// One decision, three outcomes, and only the middle one is obvious: skip the
// "unsaved edits will be lost" confirm when hot exit kept the work, show it
// when hot exit is off, and *also* show it when hot exit was on but the stash
// did not land. The third is the one worth a test, because getting it wrong
// looks exactly like the first until the day somebody's disk is full.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor } from "@solidjs/testing-library";

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorAgent";

installResizeObserver();

const REPO = "/space/proj/main";
const FILE = `${REPO}/a.txt`;

let hotExit = true;
/** Whether the stubbed editor pane manages to stash. */
let stashLands = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return Promise.resolve({ ...BASE_SETTINGS, editorDefaults: { ...BASE_SETTINGS.editorDefaults, hotExit } });
      case "file_exists":
        return Promise.resolve(String(args.path) === FILE);
      case "hot_exit_load":
        return Promise.resolve({});
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

// The close handler the app registers, plus whether it went through with the
// quit. `destroy` is the only observable "the window actually closed", since
// the handler always preventDefaults first.
let onClose: ((e: { preventDefault: () => void }) => unknown) | null = null;
let destroyed = 0;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (fn: (e: { preventDefault: () => void }) => unknown) => {
      onClose = fn;
      return Promise.resolve(() => {});
    },
    destroy: () => {
      destroyed++;
      return Promise.resolve();
    },
  }),
}));

// A stand-in for the editor pane: reports the open file dirty, and answers the
// stash handshake with whatever this test wants. Everything under test here is
// Editor's decision, not the stashing itself (which `hotExit.test.tsx` covers
// against the real pane).
vi.mock("./CodeEditor", async () => {
  const { createEffect } = await import("solid-js");
  return {
    default: (props: { activePath: string | null; onDirty: (p: string, d: boolean) => void }) => {
      // An effect, not a call in the body: `activePath` is null on the first
      // render (nothing is open yet) and arrives later, so a one-shot read
      // would leave every buffer looking clean and this whole suite vacuous.
      createEffect(() => {
        if (props.activePath) props.onDirty(props.activePath, true);
      });
      return null;
    },
  };
});
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { default: PaneView } = await import("../../tabs/PaneView");
const { DEFAULT_SETTINGS, loadSettings } = await import("../Settings/settingsStore");
const { emitWith, onWith, OPEN_IN_EDITOR, EDITOR_STASH_DIRTY, EDITOR_STASH_RESULT } = await import(
  "../../utils/events"
);
const BASE_SETTINGS = structuredClone(DEFAULT_SETTINGS);

const CONFIRM = /Close anyway/;

let mounted: ReturnType<typeof render> | null = null;
let offStash: (() => void) | null = null;

/** Stand in for CodeEditor's half of the handshake. */
function answerStashWith(ok: boolean) {
  offStash = onWith<{ requestId: string }>(EDITOR_STASH_DIRTY, ({ requestId }) =>
    emitWith(EDITOR_STASH_RESULT, { requestId, ok }),
  );
}

async function mountWithDirtyFile() {
  mounted = render(() => (
      <>
        <Editor selected={selectionFor(REPO) as never} />
        <PaneView pinKind="file" />
      </>
    ));
  await waitFor(() => expect(onClose).not.toBeNull());
  emitWith(OPEN_IN_EDITOR, { path: FILE });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
  // Wait for the app's own dirty mark, not merely for the tab. The stubbed pane
  // reports dirty from an effect, and a close requested before that lands takes
  // the "nothing unsaved" path and quietly makes every test here vacuous.
  await waitFor(() => expect(mounted!.container.querySelector(".tab-dirty")).toBeTruthy());
}

/**
 * Ask the window to close, the way the titlebar button does.
 *
 * Returns without awaiting the handler, and that is not laziness: on every path
 * that reaches the confirm dialog the handler is parked on a promise nobody
 * will resolve until a button is clicked, so awaiting it is awaiting the user.
 * Tests that expect the dialog wait for the dialog; the one that expects a
 * clean close awaits `done`.
 */
function requestClose() {
  let prevented = false;
  const done = onClose!({ preventDefault: () => (prevented = true) });
  return { done, wasPrevented: () => prevented };
}

beforeEach(async () => {
  // Tabs persist to localStorage and `Editor` restores them on mount, so a test
  // that opens a file leaves the next one mounting with that tab already
  // active. The stubbed pane marks any active path dirty, which silently turns
  // "nothing is dirty" cases into "something is" - and those park on the
  // confirm dialog rather than failing an assertion.
  localStorage.clear();
  hotExit = true;
  stashLands = true;
  destroyed = 0;
  onClose = null;
  await loadSettings();
});
afterEach(() => {
  offStash?.();
  offStash = null;
  mounted?.unmount();
  mounted = null;
});

describe("closing the window with unsaved edits", () => {
  it("goes straight through once hot exit has kept the work", async () => {
    answerStashWith(true);
    await mountWithDirtyFile();

    const closing = requestClose();
    await closing.done;

    expect(closing.wasPrevented(), "the handler took over the close").toBe(true);
    expect(screen.queryByText(CONFIRM)).toBeNull();
    expect(destroyed).toBe(1);
  });

  it("still asks when the stash did not land", async () => {
    // The preference being on is not evidence that anything reached the disk.
    stashLands = false;
    answerStashWith(stashLands);
    await mountWithDirtyFile();

    requestClose();

    await waitFor(() => expect(screen.getByText(CONFIRM)).toBeTruthy());
    expect(destroyed).toBe(0);
  });

  it("still asks when nothing answers the handshake at all", async () => {
    // No subscriber: the pane is not mounted, or was torn down mid-flight.
    // `requestStash` resolves false on its own timeout, and the fallback is the
    // dialog rather than a window that never closes.
    await mountWithDirtyFile();

    vi.useFakeTimers();
    requestClose();
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();

    await waitFor(() => expect(screen.getByText(CONFIRM)).toBeTruthy());
    expect(destroyed).toBe(0);
  });

  it("asks as it always did with the preference off, and stashes nothing", async () => {
    hotExit = false;
    await loadSettings();
    const asked: string[] = [];
    offStash = onWith<{ requestId: string }>(EDITOR_STASH_DIRTY, ({ requestId }) => asked.push(requestId));
    await mountWithDirtyFile();

    requestClose();

    await waitFor(() => expect(screen.getByText(CONFIRM)).toBeTruthy());
    expect(asked, "the editor was never even asked to stash").toEqual([]);
    expect(destroyed).toBe(0);
  });

  it("still rewrites the stash with nothing dirty, so a stale entry cannot outlive it", async () => {
    // The bug this exists to prevent: the stash file is the whole of the
    // feature's memory, and a quit that wrote nothing left the *previous* run's
    // entries in it. The next launch loaded them, marked those tabs dirty and
    // handed the old text back - over files that had since been saved, and
    // without even a conflict banner, because `savedText` still matched disk.
    //
    // So a clean quit is not a quit with nothing to do. It has to write, and
    // then close without asking about edits that do not exist.
    answerStashWith(true);
    const asked: string[] = [];
    offStash = onWith<{ requestId: string }>(EDITOR_STASH_DIRTY, ({ requestId }) => asked.push(requestId));
    mounted = render(() => (
      <>
        <Editor selected={selectionFor(REPO) as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(onClose).not.toBeNull());

    const closing = requestClose();
    await closing.done;

    expect(asked, "the stash was rewritten even though nothing was dirty").toHaveLength(1);
    expect(closing.wasPrevented()).toBe(true);
    // Closed on its own, with no "unsaved edits will be lost" prompt in the way.
    await waitFor(() => expect(destroyed).toBe(1));
    expect(screen.queryByText(CONFIRM)).toBeNull();
  });

  it("closes without a word when hot exit is off and nothing is dirty", async () => {
    // With the key off there is no stash to keep current, so there is nothing
    // worth asking about. The close is still taken over rather than let
    // through: the handler blocks first on every path, because the app's own
    // quit guards (utils/closeGuard) are consulted asynchronously and a handler
    // that returned unprevented would have closed the window before they
    // answered. So "out of the way" is measured as a silent destroy.
    hotExit = false;
    await loadSettings();
    mounted = render(() => (
      <>
        <Editor selected={selectionFor(REPO) as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(onClose).not.toBeNull());

    const closing = requestClose();
    await closing.done;

    expect(closing.wasPrevented()).toBe(true);
    await waitFor(() => expect(destroyed).toBe(1));
    expect(screen.queryByText(CONFIRM)).toBeNull();
  });
});
