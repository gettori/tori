import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
// Type-only, so it is erased and does not load the module ahead of the mocks
// the dynamic imports below are waiting for.
import type { ToastEvent } from "../../utils/events";
import { closeOf } from "../../test/tabs";
import { installAnimationFrame } from "../../test/frames";

// Scratch buffers from the pane's side.
//
// The claim the whole feature rests on is that an untitled tab needs no special
// case anywhere: it is a real file, so the tab store keeps it, the restore finds
// it alive, and hot exit stashes it exactly as it does any other buffer. Those
// three are asserted here because no unit can see them - `scratch.ts` knows
// nothing about tabs and `editorTabPersist.ts` knows nothing about scratches,
// and the point is precisely that neither had to.
//
// The other half is the two places a scratch *does* differ from an ordinary
// file, both of which delete something: promoting one with Save-as, and closing
// one nobody typed in.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/a.ts`;
// This suite closes tabs, and the close button now lives on the row the bar
// draws rather than on its measuring ghost. See the helper for why the two
// differ in jsdom.
installAnimationFrame();

const SCRATCH_DIR = "/home/me/.config/sway/scratch";
const SCRATCH = `${SCRATCH_DIR}/Untitled-1`;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
/** What each path holds on disk. A path absent from it does not exist, and a
 *  path mapped to null is one whose read fails. */
let onDisk: Record<string, string | null> = {};
/** What the last quit left, as `hot_exit_load` would hand it back. */
let stash: Record<string, unknown> = {};
/** When true, the backend refuses to make a scratch file. */
let scratchBroken = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "scratch_dir":
        return Promise.resolve(SCRATCH_DIR);
      case "scratch_new":
        return scratchBroken ? Promise.reject("read-only home") : Promise.resolve(SCRATCH);
      case "hot_exit_load":
        return Promise.resolve(stash);
      case "file_exists":
        return Promise.resolve(String(args.path) in onDisk);
      case "fs_read_file": {
        const held = onDisk[String(args.path)];
        return held == null ? Promise.reject("ENOENT") : Promise.resolve(held);
      }
      case "fs_read_dir":
        return Promise.resolve([]);
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

type CodeProps = { activePath: string | null; openPaths: string[] };
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { setBufferAccess } = await import("./liveBuffers");
const {
  emitWith,
  onWith,
  TOAST,
  OPEN_IN_EDITOR,
  EDITOR_NEW_SCRATCH,
  EDITOR_SAVE_AS,
  EDITOR_REOPEN_CLOSED,
} = await import("../../utils/events");

const LS_TABS_KEY = "sway.editor.tabs.v1";
const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

// The real CodeEditor registers this on mount and the stub above cannot, so the
// suite plays the buffer's part for Save-as, which is the one thing here that
// needs a buffer's text. `texts` is what the editor would be holding; a path
// absent from it is a path no buffer holds.
//
// The close cleanup deliberately reads none of this: it asks `onDisk`, because
// a discarded buffer and an unopened tab are both cases the buffer cannot
// answer for.
let texts: Record<string, string> = {};
let dirtyPaths = new Set<string>();
let dropAccess: (() => void) | null = null;

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
  await waitFor(() => expect(listening.ready).toBe(true));
  // The scratch directory arrives one await after mount, and every delete path
  // is gated on knowing it.
  await waitFor(() => expect(invokes.some((i) => i.cmd === "scratch_dir")).toBe(true));
}

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

function argsFor(cmd: string) {
  return invokes.filter((i) => i.cmd === cmd).map((i) => i.args);
}

/** The modal `askText` raised, found by its title. The field is reached through
 *  the accessibility tree rather than through the title's parent: since the
 *  prompt moved onto `Dialog`, the title is the panel's heading and the input is
 *  no longer its sibling. The role narrows it to the field, since the dialog
 *  carries the same name as its heading. */
function answerPrompt(title: string, value: string) {
  fireEvent.input(screen.getByRole("textbox", { name: title }), { target: { value } });
  fireEvent.click(screen.getByText("OK"));
}

function storedTabs() {
  return JSON.parse(localStorage.getItem(LS_TABS_KEY) || "{}");
}

beforeEach(() => {
  code = null;
  listening.ready = false;
  invokes.length = 0;
  onDisk = {};
  stash = {};
  scratchBroken = false;
  texts = {};
  dirtyPaths = new Set();
  localStorage.clear();
  dropAccess = setBufferAccess({
    textOf: (p) => (p in texts ? texts[p] : null),
    isDirty: (p) => dirtyPaths.has(p),
    adopt: (p, t) => {
      texts[p] = t;
      dirtyPaths.delete(p);
    },
    // Save-as never patches a buffer; the search results buffer is what does.
    patch: () => "absent" as const,
  });
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  dropAccess?.();
  localStorage.clear();
});

describe("opening an untitled buffer", () => {
  it("asks the backend for a file and opens a tab on it", async () => {
    await mountEditor();
    emitWith(EDITOR_NEW_SCRATCH, {});
    await waitFor(() => expect(code?.activePath).toBe(SCRATCH));
    expect(argsFor("scratch_new")).toHaveLength(1);
  });

  it("belongs to the workspace that was selected when it was opened", async () => {
    // The ownership question the plan asked. A scratch is bucketed like every
    // other tab, so it is stored under the branch-unit folder that was selected
    // - here `/space/proj/main` - and not under the scratch directory, which is
    // not a workspace and could never be selected as one.
    await mountEditor();
    emitWith(EDITOR_NEW_SCRATCH, {});
    await waitFor(() => expect(code?.activePath).toBe(SCRATCH));
    await waitFor(() => expect(storedTabs()[REPO]?.paths).toEqual([SCRATCH]));
    expect(storedTabs()[REPO].active).toBe(SCRATCH);
    expect(Object.keys(storedTabs())).toEqual([REPO]);
  });

  it("comes back as a tab on the next launch, not just as text", async () => {
    // What a synthetic `sway://` id could never have done: `toStore` drops those
    // on purpose, so an untitled tab built on one would restore as nothing.
    localStorage.setItem(
      LS_TABS_KEY,
      JSON.stringify({ [REPO]: { paths: [SCRATCH], active: SCRATCH, savedAt: Date.now() } }),
    );
    onDisk[SCRATCH] = "";
    await mountEditor();
    await waitFor(() => expect(code?.openPaths).toEqual([SCRATCH]));
    expect(code?.activePath).toBe(SCRATCH);
  });

  it("comes back carrying whatever the last quit stashed for it", async () => {
    // Hot exit keys on the absolute path, and a scratch has one, so the unsaved
    // text is kept with no scratch-shaped branch in `hotExit.ts` at all. The
    // text itself is CodeEditor's to restore; what the pane can see is that the
    // tab comes back knowing it is carrying work.
    localStorage.setItem(
      LS_TABS_KEY,
      JSON.stringify({ [REPO]: { paths: [SCRATCH], active: SCRATCH, savedAt: Date.now() } }),
    );
    onDisk[SCRATCH] = "";
    stash = { [SCRATCH]: { savedText: "", state: { doc: "half a thought" }, savedAt: Date.now() } };
    await mountEditor();
    await waitFor(() => expect(code?.openPaths).toEqual([SCRATCH]));
    // The pane has the buffer, which is not the same as the strip having drawn
    // the tab: the bar corrects its visible count in a frame of its own. The
    // name is a prefix match because a stashed tab wears a dirty dot, and the
    // dot is inside the button.
    await screen.findByRole("tab", { name: /^Untitled-1/ });
    fireEvent.click(closeOf(/^Untitled-1/));
    await waitFor(() => expect(screen.getByText(/Discard unsaved changes/)).toBeTruthy());
  });

  it("says so when the file could not be made, rather than opening an empty tab", async () => {
    // The toast host is App's, not this pane's, so the event is what there is
    // to see from here.
    const said: string[] = [];
    const off = onWith<ToastEvent>(TOAST, (t) => said.push(t.message));
    scratchBroken = true;
    await mountEditor();
    emitWith(EDITOR_NEW_SCRATCH, {});
    await waitFor(() => expect(said).toEqual(["Could not create a scratch file."]));
    // Still the empty pane: no tab was opened onto a file that does not exist.
    expect(screen.getByText(/Open a file from the tree/)).toBeTruthy();
    off();
  });
});

describe("saving one under a real name", () => {
  it("writes it where you said and takes the tab with it", async () => {
    await mountEditor();
    await open(SCRATCH);
    texts[SCRATCH] = "half a thought";

    emitWith(EDITOR_SAVE_AS, {});
    await waitFor(() => expect(screen.getByText("Save as")).toBeTruthy());
    answerPrompt("Save as", "notes.md");

    await waitFor(() => expect(code?.activePath).toBe(`${REPO}/notes.md`));
    expect(argsFor("fs_write_file")).toEqual([
      { path: `${REPO}/notes.md`, contents: "half a thought" },
    ]);
    // And the untitled file it was is gone, rooted at the scratch directory so
    // the containment check has something to hold it to.
    await waitFor(() =>
      expect(argsFor("fs_delete")).toEqual([
        { root: SCRATCH_DIR, path: SCRATCH, noun: "scratch folder" },
      ]),
    );
    expect(code?.openPaths).toEqual([`${REPO}/notes.md`]);
  });

  it("leaves an ordinary file exactly where it was", async () => {
    // The asymmetry, stated: Save-as on a real file is a copy the tab follows,
    // which is what Save As means everywhere. Only a scratch loses its original.
    await mountEditor();
    await open(FILE);
    texts[FILE] = "export const a = 1;";

    emitWith(EDITOR_SAVE_AS, {});
    await waitFor(() => expect(screen.getByText("Save as")).toBeTruthy());
    answerPrompt("Save as", "b.ts");

    await waitFor(() => expect(code?.activePath).toBe(`${REPO}/b.ts`));
    expect(argsFor("fs_delete")).toEqual([]);
  });

  it("does nothing at all when the prompt is cancelled", async () => {
    await mountEditor();
    await open(SCRATCH);
    texts[SCRATCH] = "half a thought";

    emitWith(EDITOR_SAVE_AS, {});
    await waitFor(() => expect(screen.getByText("Save as")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(screen.queryByText("Save as")).toBeNull());
    expect(argsFor("fs_write_file")).toEqual([]);
    expect(argsFor("fs_delete")).toEqual([]);
    expect(code?.activePath).toBe(SCRATCH);
  });

  it("says why when the answer names no file", async () => {
    // A refusal has to be visible. Left silent, the box closes, nothing is
    // written and nothing is said, which reads as the command being broken.
    const said: string[] = [];
    const off = onWith<ToastEvent>(TOAST, (t) => said.push(t.message));
    await mountEditor();
    await open(SCRATCH);
    texts[SCRATCH] = "half a thought";

    emitWith(EDITOR_SAVE_AS, {});
    await waitFor(() => expect(screen.getByText("Save as")).toBeTruthy());
    answerPrompt("Save as", "src/");

    await waitFor(() => expect(said).toEqual([`"src/" does not name a file.`]));
    expect(argsFor("fs_write_file")).toEqual([]);
    expect(code?.activePath).toBe(SCRATCH);
    off();
  });

  it("asks before replacing a file that is already there", async () => {
    onDisk[`${REPO}/notes.md`] = "something already here";
    await mountEditor();
    await open(SCRATCH);
    texts[SCRATCH] = "half a thought";

    emitWith(EDITOR_SAVE_AS, {});
    await waitFor(() => expect(screen.getByText("Save as")).toBeTruthy());
    answerPrompt("Save as", "notes.md");

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText(/already exists/)).toBeNull());
    expect(argsFor("fs_write_file")).toEqual([]);
    // And the scratch is still a scratch, which is the half a declined write
    // could most easily get wrong.
    expect(code?.activePath).toBe(SCRATCH);
    expect(argsFor("fs_delete")).toEqual([]);
  });
});

describe("closing an untitled buffer", () => {
  const deleted = () => argsFor("fs_delete");
  const TRASHED = { root: SCRATCH_DIR, path: SCRATCH, noun: "scratch folder" };

  it("takes an empty one's file with it, and does not offer it back", async () => {
    // Every Cmd+N makes a file. Without this the directory fills with empties
    // and the numbering climbs past anything anyone wrote.
    onDisk[SCRATCH] = "";
    await mountEditor();
    await open(SCRATCH);

    fireEvent.click(closeOf("Untitled-1"));
    await waitFor(() => expect(deleted()).toEqual([TRASHED]));
    // Cmd+Shift+T would otherwise open a tab onto a file that is no longer
    // there, which reads as a broken reopen rather than as a finished scratch.
    emitWith(EDITOR_REOPEN_CLOSED, {});
    await waitFor(() => expect(code?.openPaths).toEqual([]));
    expect(code?.activePath).toBe(null);
  });

  it("takes it with it after the unsaved work in it was discarded too", async () => {
    // The file is the witness, not the buffer. A discard throws the buffer's
    // text away and never touches disk, so asking the buffer would leave an
    // empty scratch behind in exactly the sequence that produces one: open,
    // type, close, discard.
    onDisk[SCRATCH] = "";
    await mountEditor();
    await open(SCRATCH);
    dirtyPaths.add(SCRATCH);
    texts[SCRATCH] = "typed and then thrown away";
    // The pane's own dirty flag is CodeEditor's to report, and the stub cannot,
    // so the discard confirm is driven by the stash instead - the same state a
    // relaunch into unsaved work leaves the tab in.
    mounted?.unmount();
    mounted = null;
    localStorage.setItem(
      LS_TABS_KEY,
      JSON.stringify({ [REPO]: { paths: [SCRATCH], active: SCRATCH, savedAt: Date.now() } }),
    );
    stash = { [SCRATCH]: { savedText: "", state: { doc: "typed" }, savedAt: Date.now() } };
    invokes.length = 0;
    listening.ready = false;
    await mountEditor();
    await waitFor(() => expect(code?.openPaths).toEqual([SCRATCH]));
    await screen.findByRole("tab", { name: /^Untitled-1/ });

    fireEvent.click(closeOf(/^Untitled-1/));
    await waitFor(() => expect(screen.getByText("Discard")).toBeTruthy());
    fireEvent.click(screen.getByText("Discard"));

    await waitFor(() => expect(deleted()).toEqual([TRASHED]));
  });

  it("keeps one that has something in it", async () => {
    onDisk[SCRATCH] = "a thought worth keeping";
    await mountEditor();
    await open(SCRATCH);

    fireEvent.click(closeOf("Untitled-1"));
    await waitFor(() => expect(code?.openPaths).toEqual([]));
    expect(deleted()).toEqual([]);
  });

  it("keeps one whose file it could not read", async () => {
    // Never a delete on a guess. A read that failed says nothing about what the
    // file holds, and the wrong answer here throws away work nobody can get back.
    await mountEditor();
    await open(SCRATCH);

    fireEvent.click(closeOf("Untitled-1"));
    await waitFor(() => expect(code?.openPaths).toEqual([]));
    expect(deleted()).toEqual([]);
  });

  it("never deletes an ordinary file, and does not even read one to decide", async () => {
    onDisk[FILE] = "";
    await mountEditor();
    await open(FILE);
    invokes.length = 0;

    fireEvent.click(closeOf("a.ts"));
    await waitFor(() => expect(code?.openPaths).toEqual([]));
    expect(deleted()).toEqual([]);
    expect(argsFor("fs_read_file")).toEqual([]);
  });
});
