import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createEffect } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The blame toggle: a button in the editor tab strip, a localStorage preference,
// and a prop CodeEditor turns into a compartment reconfigure. The mechanism is
// tested in blameGutter.test.ts; what is here is the wiring between the control
// and the editor, which is otherwise three one-liners nothing exercises.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorAgent";

installResizeObserver();

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/a.ts`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "file_exists":
        return Promise.resolve(String(args.path) === FILE);
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

const seen: (boolean | undefined)[] = [];
/** The most recent value CodeEditor was handed. */
const last = () => seen[seen.length - 1];
vi.mock("./CodeEditor", () => ({
  default: (props: { blame?: boolean }) => {
    createEffect(() => seen.push(props.blame));
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { BLAME_KEY, reloadBlamePref } = await import("../../utils/blamePref");

/** Stand in for a previous session having left the preference on.
 *
 * The preference is a module-level signal now, read from localStorage once at
 * import, because the editor's toggle and the Settings row are two surfaces on
 * one preference and a signal each meant they disagreed until a remount. Writing
 * the key alone therefore no longer reaches the app - which is also why these
 * tests kept passing on the signal the *previous* test left behind until this
 * was added. */
function previousSessionLeftBlame(on: boolean) {
  localStorage.setItem(BLAME_KEY, on ? "1" : "0");
  reloadBlamePref();
}
const { syntheticId } = await import("../../utils/syntheticTabs");

const selection = selectionFor(REPO);

const BUTTON = /Git blame: show who last changed/;
const ON_BUTTON = /Showing git blame/;

let mounted: ReturnType<typeof render> | null = null;

async function mountWithFile() {
  mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
  await waitFor(() => expect(listening.ready).toBe(true));
  emitWith(OPEN_IN_EDITOR, { path: FILE });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

beforeEach(() => {
  localStorage.clear();
  reloadBlamePref();
  seen.length = 0;
  listening.ready = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the blame toggle", () => {
  it("starts off, and switching it on reaches the editor and is remembered", async () => {
    // Off by default: blame costs a gutter column and a line of text beside the
    // cursor on every file, which is not what most opens are for.
    await mountWithFile();
    await waitFor(() => expect(last()).toBe(false));

    fireEvent.click(screen.getByLabelText(BUTTON));

    await waitFor(() => expect(last()).toBe(true));
    expect(localStorage.getItem(BLAME_KEY)).toBe("1");
    // The button says which state it is in, not which state it would move to.
    expect(screen.getByLabelText(ON_BUTTON)).toBeTruthy();
  });

  it("comes back on for the next session once it has been asked for", async () => {
    previousSessionLeftBlame(true);
    await mountWithFile();

    expect(last()).toBe(true);
    expect(screen.getByLabelText(ON_BUTTON)).toBeTruthy();
  });

  it("switching it off reaches the editor too", async () => {
    previousSessionLeftBlame(true);
    await mountWithFile();

    fireEvent.click(screen.getByLabelText(ON_BUTTON));

    await waitFor(() => expect(last()).toBe(false));
    expect(localStorage.getItem(BLAME_KEY)).toBe("0");
  });

  it("offers no toggle on a tab that is not a file", async () => {
    // A commit log has no lines to blame, and the control would sit there doing
    // nothing beside a view that cannot use it.
    mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    emitWith(OPEN_IN_EDITOR, { path: syntheticId("log", REPO) });

    await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
    expect(screen.queryByLabelText(BUTTON)).toBeNull();
    expect(screen.queryByLabelText(ON_BUTTON)).toBeNull();
  });
});
