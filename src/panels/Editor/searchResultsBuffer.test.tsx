import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { EditorView } from "@codemirror/view";

// The editable results buffer, through the real component and the real
// `liveBuffers` seam. What is pinned here is where an edit *goes*: to disk, to
// an open buffer, or nowhere with a reason. The document rules themselves are
// `searchResultsDoc.test.ts`'s job, and the backend's fail-closed writing is
// `search.rs`'s; this is the routing between them, which is the only part no
// other test can see.

type FileEdits = { path: string; edits: { line: number; was: string; now: string }[] };
type ApplyCall = { root: string; files: FileEdits[] };

/** Files on disk, by absolute path. */
let disk: Record<string, string> = {};
/** Files open in the editor, by absolute path. */
let open: Record<string, { text: string; dirty: boolean }> = {};
let applyCalls: ApplyCall[] = [];
let reads: string[] = [];
const marked: string[] = [];

vi.mock("../../utils/selfWrites", () => ({
  markSelfWrite: (p: string) => marked.push(p),
  isSelfWrite: () => false,
}));

// Stands in for `apply_line_edits`, guarding on `was` the way the Rust command
// does (which has its own tests). A test double that wrote regardless would
// make every refusal here unreachable.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "apply_line_edits") {
      const call = args as unknown as ApplyCall;
      applyCalls.push(call);
      const changed: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const file of call.files) {
        const abs = `${call.root}/${file.path}`;
        const lines = (disk[abs] ?? "").split("\n");
        if (file.edits.some((e) => lines[e.line - 1] !== e.was)) {
          skipped.push({ path: file.path, reason: "changed since the search" });
          continue;
        }
        for (const e of file.edits) lines[e.line - 1] = e.now;
        disk[abs] = lines.join("\n");
        changed.push(file.path);
      }
      return Promise.resolve({ changed, skipped });
    }
    if (cmd === "fs_read_file") {
      reads.push(args.path as string);
      return Promise.resolve(disk[args.path as string] ?? "");
    }
    return Promise.resolve(null);
  },
}));

import { setBufferAccess } from "./liveBuffers";
import { clearSearchBuffers, openSearchResults, searchBuffer } from "./searchResultsStore";
import { prefixLen } from "./searchResultsDoc";
import SearchResultsBuffer from "./SearchResultsBuffer";

const ROOT = "/space/proj";
const A = `${ROOT}/src/a.ts`;
const B = `${ROOT}/src/b.ts`;
const C = `${ROOT}/src/c.ts`;

const MATCHES = [
  { path: "src/a.ts", line: 2, text: "const needle = 1" },
  { path: "src/b.ts", line: 1, text: "needle" },
  { path: "src/c.ts", line: 1, text: "c needle" },
];

/** Which buffer line each file's one match sits on, 1-based as CodeMirror
 *  counts: two notes, a blank, a header, the row, then blank/header/row. */
const ROW = { a: 5, b: 8, c: 11 };

let mounted: ReturnType<typeof render> | null = null;
let dropAccess: (() => void) | null = null;

/** Plays CodeEditor's part of `liveBuffers`, including the patch that leaves a
 *  buffer as dirty as it found it. */
function registerBuffers() {
  return setBufferAccess({
    textOf: (p) => open[p]?.text ?? null,
    isDirty: (p) => !!open[p]?.dirty,
    adopt: (p, t) => {
      if (open[p]) open[p] = { text: t, dirty: false };
    },
    patch: (p, edits) => {
      const buf = open[p];
      if (!buf) return "absent";
      const lines = buf.text.split("\n");
      if (edits.some((e) => lines[e.line - 1] !== e.was)) return "stale";
      for (const e of edits) lines[e.line - 1] = e.now;
      buf.text = lines.join("\n");
      return "applied";
    },
  });
}

function mount(query = "needle", matches = MATCHES) {
  const id = openSearchResults(ROOT, query, matches);
  mounted = render(() => <SearchResultsBuffer id={id} />);
  return id;
}

const view = () =>
  EditorView.findFromDOM(mounted!.container.querySelector(".cm-editor") as HTMLElement)!;

/** Retype one row's text, the way a keystroke inside it would. */
function retype(id: string, row: number, text: string) {
  const v = view();
  const line = v.state.doc.line(row);
  v.dispatch({
    changes: { from: line.from + prefixLen(searchBuffer(id)!.doc), to: line.to, insert: text },
  });
}

const applyButton = () => screen.getByRole("button", { name: /Apply/ });

beforeEach(() => {
  clearSearchBuffers();
  disk = {
    [A]: "one\nconst needle = 1\nthree",
    [B]: "needle",
    [C]: "c needle",
  };
  open = {};
  applyCalls = [];
  reads = [];
  marked.length = 0;
  dropAccess = registerBuffers();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  dropAccess?.();
  dropAccess = null;
});

describe("materialising a search", () => {
  it("shows one row per match, each carrying its own line number", () => {
    mount();
    const doc = view().state.doc;
    expect(doc.line(4).text).toBe("src/a.ts");
    expect(doc.line(ROW.a).text).toBe("2: const needle = 1");
    expect(doc.line(ROW.b).text).toBe("1: needle");
    expect(doc.line(ROW.c).text).toBe("1: c needle");
  });

  it("opens as a tab of its own workspace, so two projects are two buffers", () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail.path);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      const id = mount();
      expect(seen).toEqual([id]);
      expect(id).toContain(encodeURIComponent(ROOT));
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }
  });

  it("hands an edited buffer back rather than rebuilding it under the edits", () => {
    // The Open button is the same click that opened it. Refreshing the results
    // would be a reasonable reading of a second press; throwing away typed
    // edits to do it is not.
    const id = mount();
    retype(id, ROW.a, "const pin = 1");
    expect(openSearchResults(ROOT, "needle", MATCHES)).toBe(id);
    expect(searchBuffer(id)!.state!.doc.line(ROW.a).text).toBe("2: const pin = 1");
  });
});

describe("coming back to a buffer another tab was shown over", () => {
  it("keeps the edits, and keeps enforcing its own rules", () => {
    // The Editor unmounts a synthetic tab's view when another tab is selected,
    // which is why the document lives in the store. The trap is that the
    // *configuration* travels with it: a state handed to a second mount still
    // carries the first mount's extensions, which close over a destroyed view
    // and signals nothing renders. Both halves are asserted, because the doc
    // coming back looks like success on its own.
    const id = mount();
    retype(id, ROW.a, "const pin = 1");
    mounted!.unmount();
    mounted = render(() => <SearchResultsBuffer id={id} />);

    expect(view().state.doc.line(ROW.a).text).toBe("2: const pin = 1");

    // The guard is live: a refused keystroke still says so, in this mount.
    const before = view().state.doc.toString();
    const line = view().state.doc.line(ROW.b);
    view().dispatch({ changes: { from: line.to, insert: "\nan extra line" } });
    expect(view().state.doc.toString()).toBe(before);
    expect(screen.getByRole("status").textContent).toMatch(/cannot be added or removed/);

    // And so is the update listener: the count follows a new edit rather than
    // sitting on whatever `build` worked out once.
    retype(id, ROW.b, "pin");
    expect(applyButton().textContent).toMatch(/Apply to 2 files/);
  });
});

describe("what the buffer will not let you do", () => {
  it("refuses a change to the line count, and says why", () => {
    const id = mount();
    const before = view().state.doc.toString();
    const line = view().state.doc.line(ROW.a);
    view().dispatch({ changes: { from: line.to, insert: "\nan extra line" } });
    expect(view().state.doc.toString()).toBe(before);
    expect(screen.getByRole("status").textContent).toMatch(/cannot be added or removed/);
    expect(searchBuffer(id)!.doc.rows.length).toBe(11);
  });

  it("takes the complaint down once an edit gets through", () => {
    // A refusal is about one keystroke. Left on screen it reads as a complaint
    // about whatever was typed after it, which is the edit that worked.
    const id = mount();
    const line = view().state.doc.line(ROW.a);
    view().dispatch({ changes: { from: line.to, insert: "\nan extra line" } });
    expect(screen.getByRole("status")).toBeTruthy();
    retype(id, ROW.a, "const pin = 1");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("writing edits back", () => {
  it("writes an edited line to its own file and marks the write as ours", async () => {
    const id = mount();
    retype(id, ROW.a, "const pin = 1");
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyCalls.length).toBe(1));
    expect(applyCalls[0]).toEqual({
      root: ROOT,
      files: [{ path: "src/a.ts", edits: [{ line: 2, was: "const needle = 1", now: "const pin = 1" }] }],
    });
    expect(disk[A]).toBe("one\nconst pin = 1\nthree");
    // Twice: once over the batch as it goes out, once from the moment it
    // landed, so the watcher's own debounce still falls inside the window.
    expect(marked.filter((p) => p === A).length).toBe(2);
    await screen.findByText(/Wrote 1 file/);
  });

  it("hands the new bytes to a clean open buffer instead of leaving it stale", async () => {
    // The other half of marking the write as ours: the echo that would have
    // reloaded this tab is suppressed, so the tab has to be told directly or it
    // sits on pre-write text whose next save reverts the write.
    const id = mount();
    open[A] = { text: "one\nconst needle = 1\nthree", dirty: false };
    retype(id, ROW.a, "const pin = 1");
    fireEvent.click(applyButton());

    await waitFor(() => expect(open[A].text).toBe("one\nconst pin = 1\nthree"));
    expect(open[A].dirty).toBe(false);
    expect(reads).toEqual([A]);
  });

  it("puts the edit in an unsaved buffer rather than on disk, and leaves it dirty", async () => {
    const id = mount();
    open[A] = { text: "one\nconst needle = 1\nthree\nplus my own edit", dirty: true };
    retype(id, ROW.a, "const pin = 1");
    fireEvent.click(applyButton());

    await screen.findByText(/took the edit in an open buffer/);
    expect(open[A].text).toBe("one\nconst pin = 1\nthree\nplus my own edit");
    expect(open[A].dirty).toBe(true);
    // Disk is untouched: it is not the copy the user is looking at.
    expect(disk[A]).toBe("one\nconst needle = 1\nthree");
    expect(applyCalls).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("refuses a file whose line moved since the search, and names it", async () => {
    const id = mount();
    retype(id, ROW.b, "pin");
    disk[B] = "somebody else got here first";
    fireEvent.click(applyButton());

    await screen.findByText(/Refused src\/b\.ts: changed since the search/);
    expect(disk[B]).toBe("somebody else got here first");
    expect(view().state.doc.line(7).text).toBe("src/b.ts  refused: changed since the search");
  });

  it("applies only the file that refused when it is tried again", async () => {
    const id = mount();
    retype(id, ROW.a, "const pin = 1");
    retype(id, ROW.b, "pin");
    retype(id, ROW.c, "c pin");
    disk[C] = "c moved on";
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyCalls.length).toBe(1));
    expect(applyCalls[0].files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    await screen.findByText(/Refused src\/c\.ts/);
    expect(view().state.doc.line(4).text).toBe("src/a.ts  written back");
    expect(view().state.doc.line(10).text).toBe("src/c.ts  refused: changed since the search");

    // The refusal is resolved outside Sway, which is where it came from.
    disk[C] = "c needle";
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyCalls.length).toBe(2));
    expect(applyCalls[1].files.map((f) => f.path)).toEqual(["src/c.ts"]);
    expect(disk[C]).toBe("c pin");
    // Written once by the first apply, and not touched by the second.
    expect(disk[A]).toBe("one\nconst pin = 1\nthree");
    expect(disk[B]).toBe("pin");
  });

  it("will not write a file it has already written, however the row is edited", async () => {
    const id = mount();
    retype(id, ROW.a, "const pin = 1");
    fireEvent.click(applyButton());
    // The outcome line, not the call: the lock goes on when the write comes
    // back, which is a turn of the loop after the command went out.
    await screen.findByText(/Wrote 1 file/);

    retype(id, ROW.a, "const nail = 1");
    expect(view().state.doc.line(ROW.a).text).toBe("2: const pin = 1");
    expect(screen.getByRole("status").textContent).toMatch(/already been written back/);
    expect(applyCalls.length).toBe(1);
  });
});

describe("the results buffer, to axe", () => {
  it("has no accessibility violations", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Apply")).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});
