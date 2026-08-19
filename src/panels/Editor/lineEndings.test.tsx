// Line endings, end to end: a real `CodeEditor` over a mocked filesystem.
//
// The unit test beside this one (`lineEndings.test.ts`) covers the detection
// itself. What cannot be answered there is the thing #43 is actually about: a
// buffer holds one representation of the text and the disk holds another, and
// every derived surface (the dirty dot, the save, the reload, blame) compares
// the two. So this mounts the component that owns both and drives the whole
// round trip. It is the only suite in the repo that mounts the real editor
// rather than stubbing it, for exactly that reason.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const CRLF_FILE = `${REPO}/crlf.txt`;
const LF_FILE = `${REPO}/lf.txt`;
const MIXED_FILE = `${REPO}/mixed.txt`;

const CRLF = "one\r\ntwo\r\nthree\r\n";
const LF = "one\ntwo\nthree\n";
/** Dominantly CRLF, with one ending somebody's tool got wrong. */
const MIXED = "one\r\ntwo\nthree\r\n";

/** The mock filesystem: what each path currently holds, byte for byte. */
let disk: Record<string, string> = {};
const writes: { path: string; contents: string }[] = [];
/** How many times the editor has re-read each path, so a test can wait for the
 *  external-change handler to have actually run rather than for a timeout. */
const reads: string[] = [];
/** Local-history snapshots the save path asked the backend to take. */
const noted: { repoPath: string; path: string }[] = [];

const HEAD = "a".repeat(40);
/** One commit covering every line, so a placed blame is visible in the gutter. */
const BLAME = {
  head: HEAD,
  lines: [0, 0, 0, 0],
  commits: [{ sha: HEAD, author: "A", time: Math.floor(Date.now() / 1000), summary: "s" }],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        reads.push(path);
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "fs_write_file":
        writes.push({ path, contents: String(args.contents) });
        disk[path] = String(args.contents);
        return Promise.resolve(null);
      case "local_history_note":
        noted.push({ repoPath: String(args.repoPath), path });
        return Promise.resolve(true);
      case "file_exists":
        return Promise.resolve(path in disk);
      case "git_head_sha":
        return Promise.resolve(HEAD);
      case "git_blame":
        return Promise.resolve(BLAME);
      case "git_status":
      case "git_diff_file":
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
// No language server in this suite: the client would try to start one, and
// nothing under test here depends on a buffer being claimed.
vi.mock("./lspClient", () => ({
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: () => null,
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { emitWith, EDITOR_SAVE } = await import("../../utils/events");
const { refreshStatus, refreshMeta } = await import("../../utils/gitActions");
const { clearBlameCache } = await import("../../utils/blame");

type Dirty = { path: string; dirty: boolean };

/** The dirty flag as the tab strip would currently be showing it. */
const last = (calls: Dirty[]) => calls[calls.length - 1];

let mounted: ReturnType<typeof render> | null = null;

/** Mount the editor on one file and wait for its buffer to be built. */
async function open(path: string, opts: { blame?: boolean } = {}) {
  const dirty: Dirty[] = [];
  // `reverted` is how a test tells the editor a file moved underneath it: the
  // same handler the fs watcher reaches, driven by a prop rather than by an
  // event the mocked `listen` would swallow.
  const [signal, setSignal] = createSignal<{ paths: string[]; nonce: number } | null>(null);
  mounted = render(() => (
    <CodeEditor
      activePath={path}
      openPaths={[path]}
      projectRoot={REPO}
      goto={null}
      onDirty={(p, d) => dirty.push({ path: p, dirty: d })}
      selected={null}
      blame={opts.blame}
      reverted={signal()}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  const view = EditorView.findFromDOM(mounted.container.querySelector(".cm-editor") as HTMLElement)!;
  let nonce = 0;
  /** Rewrite the file behind the editor's back, then tell it so. */
  const rewrite = async (contents: string) => {
    disk[path] = contents;
    setSignal({ paths: [path], nonce: ++nonce });
    await waitFor(() => expect(view.state.sliceDoc()).toBe(contents));
  };
  return { dirty, view, rewrite, setReverted: setSignal };
}

/** Paste at the cursor, through CodeMirror's own paste handler rather than
 *  around it: the filter under test is applied there, not by `toText`. jsdom
 *  has no `DataTransfer`, and the handler reads only `getData`. */
function paste(view: EditorView, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  view.contentDOM.dispatchEvent(event);
}

/** Type at the top of the buffer, the way a keystroke would. */
function typeInto(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
}

beforeEach(async () => {
  disk = { [CRLF_FILE]: CRLF, [LF_FILE]: LF, [MIXED_FILE]: MIXED };
  writes.length = 0;
  reads.length = 0;
  noted.length = 0;
  clearBlameCache();
  await refreshStatus(REPO);
  await refreshMeta(REPO);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("opening a file whose lines end in CRLF", () => {
  it("reports it clean, with nothing typed into it", async () => {
    // The standing bug: the buffer's text was read back joined with "\n" while
    // `savedText` still held the raw disk string, so the two never matched and
    // the tab wore a dirty dot from the moment it opened.
    const { dirty } = await open(CRLF_FILE);
    expect(last(dirty)).toEqual({ path: CRLF_FILE, dirty: false });
  });

  it("holds the same lines an LF file of the same content would", async () => {
    const { view } = await open(CRLF_FILE);
    expect(view.state.doc.lines).toBe(4); // three lines plus the empty last one
    expect(view.state.doc.line(2).text).toBe("two");
  });

  it("reads its own text back with the endings it arrived with", async () => {
    const { view } = await open(CRLF_FILE);
    expect(view.state.lineBreak).toBe("\r\n");
    expect(view.state.sliceDoc()).toBe(CRLF);
  });

  it("touches nothing on disk just by being opened", async () => {
    // What the diff gutter reads is the file, not the buffer. An open that
    // rewrote it would put hunks under an untouched file, which is the same
    // bug wearing a different hat.
    await open(CRLF_FILE);
    expect(writes).toHaveLength(0);
    expect(disk[CRLF_FILE]).toBe(CRLF);
  });

  it("places blame on it, because the buffer still matches disk", async () => {
    // `canPlaceBlame` refuses a buffer that has drifted from the file the blame
    // was read against. A CRLF file used to drift the instant it opened, so
    // blame never appeared on one at all.
    const { view } = await open(CRLF_FILE, { blame: true });
    await waitFor(() =>
      expect(view.dom.querySelectorAll('[class*="cm-blame-age-"]').length).toBeGreaterThan(0),
    );
  });
});

describe("text arriving from outside the editor", () => {
  it("re-breaks pasted LF lines onto the buffer's own ending", async () => {
    // The sharp edge of configuring a separator at all: `EditorState.toText`
    // splits an incoming string by it, and that is what both paste and drop go
    // through. Unfiltered, three pasted lines become *one* line holding two
    // literal "\n" characters, which a save then writes out as bytes.
    const { view } = await open(CRLF_FILE);
    view.dispatch({ selection: { anchor: 0 } });
    paste(view, "a\nb\nc");

    expect(view.state.doc.line(1).text).toBe("a");
    expect(view.state.doc.line(2).text).toBe("b");
    expect(view.state.doc.line(3).text).toBe("cone"); // "c" had no break after it
    expect(view.state.sliceDoc()).not.toMatch(/[^\r]\n/);
  });

  it("leaves an LF buffer's paste exactly as it arrived", async () => {
    const { view } = await open(LF_FILE);
    view.dispatch({ selection: { anchor: 0 } });
    paste(view, "a\nb\nc");

    expect(view.state.doc.line(2).text).toBe("b");
    expect(view.state.sliceDoc()).not.toMatch(/\r/);
  });
});

describe("saving", () => {
  it("writes a CRLF file back with CRLF, byte for byte", async () => {
    const { view, dirty } = await open(CRLF_FILE);
    typeInto(view, "zero\r\n");
    expect(last(dirty).dirty).toBe(true);

    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(writes).toHaveLength(1));

    expect(writes[0].contents).toBe("zero\r\none\r\ntwo\r\nthree\r\n");
    expect(writes[0].contents).not.toMatch(/[^\r]\n/);
    expect(last(dirty).dirty).toBe(false);
  });

  it("keeps a local-history version of what it just wrote", async () => {
    // Every save, whether or not it is ever committed: the version somebody
    // goes looking for is usually the one that was never staged. After the
    // write, and by path, so what is recorded is what landed on disk.
    const { view } = await open(CRLF_FILE);
    typeInto(view, "zero\r\n");

    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(noted).toHaveLength(1));
    expect(noted[0]).toEqual({ repoPath: REPO, path: CRLF_FILE });
    expect(writes.length).toBe(1);
  });

  it("leaves an LF file on LF", async () => {
    const { view } = await open(LF_FILE);
    typeInto(view, "zero\n");

    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(writes).toHaveLength(1));

    expect(writes[0].contents).toBe("zero\none\ntwo\nthree\n");
    expect(writes[0].contents).not.toMatch(/\r/);
  });

  it("settles a mixed file onto the ending most of it already used", async () => {
    // Deliberate, and the reason a mixed file can be reported clean at all: one
    // stray ending does not get to make the buffer permanently disagree with
    // the file. The stray one is rewritten on the first save, not before.
    const { dirty, view } = await open(MIXED_FILE);
    expect(last(dirty).dirty).toBe(false);
    expect(view.state.lineBreak).toBe("\r\n");

    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].contents).toBe(CRLF);
  });
});

describe("a file that changed on disk", () => {
  it("reloads a clean CRLF buffer and keeps it clean", async () => {
    const { dirty, rewrite } = await open(CRLF_FILE);
    await rewrite("one\r\nTWO\r\nthree\r\n");
    expect(last(dirty).dirty).toBe(false);
  });

  it("adopts a conversion to LF, and then saves LF", async () => {
    // A formatter or a `.gitattributes` checkout can rewrite the endings and
    // nothing else. The buffer has to follow, or the next save would convert
    // the file straight back and show up as a diff nobody made.
    const { rewrite, view } = await open(CRLF_FILE);
    await rewrite(LF);
    expect(view.state.lineBreak).toBe("\n");

    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].contents).toBe(LF);
  });

  it("does not disturb the buffer when the bytes did not actually change", async () => {
    // The watcher fires on a touch, on an attribute change, on a save that
    // wrote the same content. Reloading on those would drop the selection and
    // the undo history for nothing.
    const { view, setReverted, dirty } = await open(CRLF_FILE);
    view.dispatch({ selection: { anchor: 5 } });
    const before = dirty.length;
    const reread = reads.length;

    setReverted({ paths: [CRLF_FILE], nonce: 1 });
    // Wait on the re-read itself, so this asserts against a handler that ran
    // rather than against one that had not started yet.
    await waitFor(() => expect(reads.length).toBe(reread + 1));

    expect(view.state.selection.main.anchor).toBe(5);
    expect(view.state.sliceDoc()).toBe(CRLF);
    expect(dirty.length).toBe(before); // nothing re-reported
  });
});
