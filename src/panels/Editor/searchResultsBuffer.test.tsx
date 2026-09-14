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
import { blankForm, clearSearchBuffers, openSearchEditor, searchBuffer } from "./searchResultsStore";
import { prefixLen, type DocRoot, type ResultMatch } from "./searchResultsDoc";
import SearchResultsBuffer from "./SearchResultsBuffer";

const ROOT = "/space/proj";
const A = `${ROOT}/src/a.ts`;
const B = `${ROOT}/src/b.ts`;
const C = `${ROOT}/src/c.ts`;

const ROOTS: DocRoot[] = [{ root: ROOT, label: "proj" }];
const MATCHES = [
  { root: ROOT, path: "src/a.ts", line: 2, text: "const needle = 1" },
  { root: ROOT, path: "src/b.ts", line: 1, text: "needle" },
  { root: ROOT, path: "src/c.ts", line: 1, text: "c needle" },
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

/** Context rows off: they read every hit file on mount and move every row,
 *  and what this file pins is routing, not layout. */
const form = () => ({ ...blankForm(), query: "needle", showContext: false });

type Confirm = (opts: { title: string; message?: string; confirmLabel?: string }) => Promise<boolean>;

function renderBuffer(id: string, roots: readonly DocRoot[] = ROOTS, confirm?: Confirm) {
  const memberRoots = roots.map((r) => ({ path: r.root, repoPath: r.root, label: r.label }));
  // No chip row: members only narrow what a re-run searches, never where a row writes.
  mounted = render(() => (
    <SearchResultsBuffer id={id} roots={memberRoots} members={[]} openPaths={[]} confirm={confirm} />
  ));
}

async function mount(opts: { matches?: ResultMatch[]; roots?: DocRoot[]; ws?: string; confirm?: Confirm } = {}) {
  const { matches = MATCHES, roots = ROOTS, ws = ROOT, confirm } = opts;
  const id = openSearchEditor(ws, form(), { matches, roots });
  renderBuffer(id, roots, confirm);
  // The seed is built into the buffer after mount, so nothing can be typed until it lands.
  await waitFor(() => expect(view().state.doc.lines).toBe(searchBuffer(id)!.doc!.rows.length));
  return id;
}

const view = () =>
  EditorView.findFromDOM(mounted!.container.querySelector(".cm-editor") as HTMLElement)!;

/** Retype one row's text, the way a keystroke inside it would. */
function retype(id: string, row: number, text: string) {
  const v = view();
  const line = v.state.doc.line(row);
  v.dispatch({
    changes: { from: line.from + prefixLen(searchBuffer(id)!.doc!), to: line.to, insert: text },
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
  it("shows one row per match, each carrying its own line number", async () => {
    await mount();
    const doc = view().state.doc;
    expect(doc.line(4).text).toBe("src/a.ts");
    expect(doc.line(ROW.a).text).toBe("2: const needle = 1");
    expect(doc.line(ROW.b).text).toBe("1: needle");
    expect(doc.line(ROW.c).text).toBe("1: c needle");
  });

  it("opens as a tab of its own workspace, so two projects are two buffers", async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail.path);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      const id = await mount();
      expect(seen).toEqual([id]);
      expect(id).toContain(encodeURIComponent(ROOT));
      // Keyed on the workspace, not on a root the search covered: the same hits
      // opened from another project are that project's buffer.
      const other = openSearchEditor("/space/other", form(), { matches: MATCHES, roots: ROOTS });
      expect(other).not.toBe(id);
      expect(other).toContain(encodeURIComponent("/space/other"));
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }
  });

  it("opens the same search again as a tab of its own, leaving the edited one alone", async () => {
    const id = await mount();
    retype(id, ROW.a, "const pin = 1");
    expect(openSearchEditor(ROOT, form(), { matches: MATCHES, roots: ROOTS })).not.toBe(id);
    expect(searchBuffer(id)!.state!.doc.line(ROW.a).text).toBe("2: const pin = 1");
  });

  it("holds a re-run off while edits wait, and asks before Enter drops them", async () => {
    // Refreshing the results is a fair reading of a new query; throwing away
    // typed edits to do it is not.
    const confirm = vi.fn<Confirm>(() => Promise.resolve(false));
    const id = await mount({ confirm });
    retype(id, ROW.a, "const pin = 1");
    const query = screen.getByRole("textbox", { name: "Search" });

    fireEvent.input(query, { target: { value: "pin" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Edits not applied yet/));

    fireEvent.keyDown(query, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(view().state.doc.line(ROW.a).text).toBe("2: const pin = 1");
    expect(applyButton().textContent).toMatch(/Apply to 1 file/);
  });
});

describe("coming back to a buffer another tab was shown over", () => {
  it("keeps the edits, and keeps enforcing its own rules", async () => {
    // The Editor unmounts a synthetic tab's view when another tab is selected,
    // which is why the document lives in the store. The trap is that the
    // *configuration* travels with it: a state handed to a second mount still
    // carries the first mount's extensions, which close over a destroyed view
    // and signals nothing renders. Both halves are asserted, because the doc
    // coming back looks like success on its own.
    const id = await mount();
    retype(id, ROW.a, "const pin = 1");
    mounted!.unmount();
    renderBuffer(id);

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
  it("refuses a change to the line count, and says why", async () => {
    const id = await mount();
    const before = view().state.doc.toString();
    const line = view().state.doc.line(ROW.a);
    view().dispatch({ changes: { from: line.to, insert: "\nan extra line" } });
    expect(view().state.doc.toString()).toBe(before);
    expect(screen.getByRole("status").textContent).toMatch(/cannot be added or removed/);
    expect(searchBuffer(id)!.doc!.rows.length).toBe(11);
  });

  it("takes the complaint down once an edit gets through", async () => {
    // A refusal is about one keystroke. Left on screen it reads as a complaint
    // about whatever was typed after it, which is the edit that worked.
    const id = await mount();
    const line = view().state.doc.line(ROW.a);
    view().dispatch({ changes: { from: line.to, insert: "\nan extra line" } });
    expect(screen.getByRole("status").textContent).toMatch(/cannot be added or removed/);
    retype(id, ROW.a, "const pin = 1");
    // The row stays up to hold the Apply button, so it is the text that has to go.
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("writing edits back", () => {
  it("writes an edited line to its own file and marks the write as ours", async () => {
    const id = await mount();
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
    const id = await mount();
    open[A] = { text: "one\nconst needle = 1\nthree", dirty: false };
    retype(id, ROW.a, "const pin = 1");
    fireEvent.click(applyButton());

    await waitFor(() => expect(open[A].text).toBe("one\nconst pin = 1\nthree"));
    expect(open[A].dirty).toBe(false);
    expect(reads).toEqual([A]);
  });

  it("puts the edit in an unsaved buffer rather than on disk, and leaves it dirty", async () => {
    const id = await mount();
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
    const id = await mount();
    retype(id, ROW.b, "pin");
    disk[B] = "somebody else got here first";
    fireEvent.click(applyButton());

    await screen.findByText(/Refused src\/b\.ts: changed since the search/);
    expect(disk[B]).toBe("somebody else got here first");
    expect(view().state.doc.line(7).text).toBe("src/b.ts  refused: changed since the search");
  });

  it("applies only the file that refused when it is tried again", async () => {
    const id = await mount();
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
    const id = await mount();
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

// One buffer over a whole Feature. `apply_line_edits` takes a single root, so
// the interesting part is the split: which rows go to which repo, and whether an
// absolute path is ever built against the wrong one.
describe("writing back across members", () => {
  const API = "/feat/api";
  const WEB = "/feat/web";
  const FEATURE = [
    { root: API, label: "Payments API" },
    { root: WEB, label: "Web App" },
  ];
  const SHARED = [
    { root: API, path: "src/index.ts", line: 1, text: "api needle" },
    { root: WEB, path: "src/index.ts", line: 1, text: "web needle" },
  ];
  /** Two notes, then blank/member/header/row twice over. */
  const ROWS = { api: 6, web: 10 };

  const mountFeature = () => mount({ matches: SHARED, roots: FEATURE, ws: "feature:f1" });

  beforeEach(() => {
    disk[`${API}/src/index.ts`] = "api needle";
    disk[`${WEB}/src/index.ts`] = "web needle";
  });

  it("sends each member's edits against that member's own root", async () => {
    const id = await mountFeature();
    retype(id, ROWS.api, "api pin");
    retype(id, ROWS.web, "web pin");
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyCalls.length).toBe(2));
    expect(applyCalls.map((c) => c.root)).toEqual([API, WEB]);
    // One relative path, two files. A batch that sent both under one root would
    // write the same repo twice and leave the other untouched.
    expect(applyCalls.map((c) => c.files.map((f) => f.path))).toEqual([
      ["src/index.ts"],
      ["src/index.ts"],
    ]);
    expect(disk[`${API}/src/index.ts`]).toBe("api pin");
    expect(disk[`${WEB}/src/index.ts`]).toBe("web pin");
    await screen.findByText(/Wrote 2 files/);
  });

  it("marks the write at the absolute path the row's own member gives it", async () => {
    const id = await mountFeature();
    retype(id, ROWS.web, "web pin");
    fireEvent.click(applyButton());

    await waitFor(() => expect(applyCalls.length).toBe(1));
    expect(marked.every((p) => p === `${WEB}/src/index.ts`)).toBe(true);
    expect(marked).not.toContain(`${API}/src/index.ts`);
  });

  it("names the member when one file refuses and the path alone names two", async () => {
    const id = await mountFeature();
    retype(id, ROWS.web, "web pin");
    disk[`${WEB}/src/index.ts`] = "somebody else got here first";
    fireEvent.click(applyButton());

    await screen.findByText(/Refused src\/index\.ts in Web App/);
    // The other member's copy of the path is untouched and still editable.
    retype(id, ROWS.api, "api pin");
    expect(view().state.doc.line(ROWS.api).text).toBe("1: api pin");
    expect(applyButton().textContent).toMatch(/Apply to 2 files/);
  });
});

describe("the results buffer, to axe", () => {
  it("has no accessibility violations", async () => {
    const id = await mount();
    // A waiting edit is what puts the status row and the Apply button on screen.
    retype(id, ROW.a, "const pin = 1");
    await waitFor(() => expect(applyButton()).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});
