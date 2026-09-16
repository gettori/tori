/**
 * The scripted degradation recipe: drives the app through a fixed sequence so
 * the slow state is reproducible and the baseline table is a measurement rather
 * than a memory of clicking around.
 *
 * Runs only when the backend was launched with both `TORI_TRACE` and
 * `TORI_RECIPE` (App imports `registerRecipeHost` unconditionally, so the
 * module is in the main chunk either way; nothing in it runs unasked). The spec
 * is `<worktrees>x<terminals>x<rounds>`, e.g.
 * `TORI_RECIPE=6x4x3`: visit six worktrees, spawn four terminals in each, then
 * flip between two of them three times.
 *
 * Five passes, in this order, because each one leaves the state the next one
 * needs: first visits (cold), terminals (the multiplier), warm A/B flips (the
 * number the plan's target is about), tab clicks, the shape mismatch. Then the
 * counts, then quit.
 *
 * The mismatch pass goes *before* the streaming rows and not after: `stream()`
 * starts `while true` producers that nothing kills, so anything placed after it
 * is measured under a load the same-shape rows it is compared against never
 * saw. It restores the layout it changed and closes the file it opened, so the
 * passes after it and the end census see the state they always did.
 *
 * Worktree switches go straight to the selection signal rather than through the
 * sidebar's `selectUnit`, so the recipe measures the switch and not the
 * checkout guard in front of it; for a worktree that guard is a no-op anyway.
 * Tab switches do go through the real strip, by clicking the tab element: the
 * strip's gesture guard asks whether a click is in flight on a `[role="tab"]`,
 * not whether it was trusted, so a synthetic click takes the same path a mouse
 * does.
 *
 * Keep the window frontmost for the whole run. `paint` and `settled` are
 * double-rAF measurements and an occluded window gets no frames, so every
 * switch times out and the report reads `paint: null` on rows that are fine.
 */

import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  emit,
  emitWith,
  EDITOR_CLOSE_TAB,
  MOVE_TAB_TO_PANE,
  type MoveTabToPane,
  OPEN_IN_EDITOR,
  type OpenInEditor,
  OPEN_TERMINAL,
  type OpenTerminal,
  SPLIT_PANE,
  type SplitPane,
} from "./events";
import { terminalIn } from "../panels/Terminal/webglLru";
import { nextSpan, traceFlush, traceNote, traceSwitchStart } from "./perfTrace";

/** Only the fields the recipe reads. The full shapes live in LeftSidebar. */
type Unit = { label: string; folderPath: string; branch: string | null; kind: string };
type Config = {
  spaces: { name: string; projects: { name: string; path: string; branchUnits: Unit[] }[] }[];
};
type Target = { sel: Record<string, unknown>; unit: Unit };

/** What the recipe needs from the app: somewhere to put the selection, and the
 *  selected workspace's pane count. App registers it on mount, because neither
 *  `setSelected` nor the layout tree is otherwise reachable. */
export type RecipeHost = {
  select: (s: Record<string, unknown>) => void;
  leaves: () => number;
};

let host: RecipeHost | null = null;
let started = false;

export function registerRecipeHost(h: RecipeHost): void {
  host = h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Startup is still finishing when the frontend first paints (see the ~800ms
// median queue wait in a boot trace), and measuring through it would measure
// that instead of a switch.
const BOOT_SETTLE_MS = 6000;
// Between steps, so a pass is not measuring the tail of the previous one.
const GAP_MS = 1200;
// A shell tab has to mount and spawn before the next one is asked for.
const SPAWN_GAP_MS = 700;
// Long enough for `seq` to run and the hidden terminals to parse it.
const STREAM_MS = 5000;

export async function startRecipe(spec: string): Promise<void> {
  if (started) return;
  started = true;
  const [worktrees, terminals, rounds] = parse(spec);
  traceNote("recipe-start", { spec, worktrees, terminals, rounds });

  await sleep(BOOT_SETTLE_MS);
  for (let i = 0; i < 40 && !host; i++) await sleep(100);
  if (!host) {
    traceNote("recipe-abort", { why: "no host registered" });
    return quit();
  }

  const units = await enumerate(worktrees);
  traceNote("recipe-units", { count: units.length, paths: units.map((u) => u.unit.folderPath) });
  if (!units.length) {
    traceNote("recipe-abort", { why: "no branch units discovered" });
    return quit();
  }

  traceNote("pass", { name: "first-visit" });
  for (const u of units) await visit(u);

  traceNote("pass", { name: "terminals", perWorktree: terminals });
  for (const u of units) {
    await visit(u);
    for (let i = 0; i < terminals; i++) {
      spawnShell(u.unit.folderPath, i);
      await sleep(SPAWN_GAP_MS);
    }
  }
  // The canned stream is `seq`, seeded backend-once as the tab's `init`, so
  // every run replays the same bytes and a remount cannot double them.
  await sleep(STREAM_MS);
  traceNote("counts", { when: "after-terminals", ...counts() });

  traceNote("pass", { name: "warm-ab", rounds });
  for (let r = 0; r < rounds; r++) {
    await visit(units[0]);
    await visit(units[Math.min(1, units.length - 1)]);
  }

  traceNote("pass", { name: "tab-clicks" });
  await clickTabs(rounds * 4);

  await mismatchPass(units, rounds);

  // The degraded row: the same A/B flip with the pair's terminals all producing
  // output. A deterministic byte producer stands in for an agent, which would
  // make the run unreproducible; the switch pays for bytes, not their author.
  const pair = [units[0], units[Math.min(1, units.length - 1)]];
  traceNote("pass", { name: "stream-start" });
  for (const u of pair) {
    for (let i = 0; i < terminals; i++) stream(u.unit.folderPath, i);
  }
  await sleep(3000);
  traceNote("counts", { when: "streaming", ...counts() });

  traceNote("pass", { name: "warm-ab-streaming", rounds });
  for (let r = 0; r < rounds; r++) {
    await visit(pair[0]);
    await visit(pair[1]);
  }

  traceNote("counts", { when: "end", ...counts() });
  traceNote("recipe-done", {});
  await sleep(500);
  return quit();
}

/** `<worktrees>x<terminals>x<rounds>`; a missing or unparsable field falls back
 *  rather than aborting the run. */
function parse(spec: string): [number, number, number] {
  const n = spec.split("x").map((p) => Number.parseInt(p, 10));
  const at = (i: number, dflt: number) => (Number.isFinite(n[i]) && n[i] > 0 ? n[i] : dflt);
  return [at(0, 6), at(1, 4), at(2, 3)];
}

async function enumerate(limit: number): Promise<Target[]> {
  let cfg: Config;
  try {
    cfg = await invoke<Config>("get_config");
  } catch (e) {
    traceNote("recipe-abort", { why: `get_config failed: ${String(e)}` });
    return [];
  }
  const out: Target[] = [];
  for (const space of cfg.spaces ?? []) {
    for (const project of space.projects ?? []) {
      for (const unit of project.branchUnits ?? []) {
        if (unit.kind === "incomplete") continue;
        out.push({
          unit,
          sel: {
            spaceName: space.name,
            projectName: project.name,
            projectPath: project.path,
            folderPath: unit.folderPath,
            branch: unit.branch ?? unit.label,
            projectKind: unit.kind,
          },
        });
      }
    }
  }
  return out.slice(0, limit);
}

async function visit(u: Target): Promise<void> {
  // Armed before the trigger: a warm switch can settle inside the same task.
  const settled = nextSpan();
  // Re-selecting the worktree already shown opens no span, so there is nothing
  // to wait for and awaiting would burn the full timeout on a no-op.
  const opened = traceSwitchStart("worktree", u.unit.folderPath);
  host?.select(u.sel);
  if (opened) await settled;
  await sleep(GAP_MS);
}

function spawnShell(folderPath: string, i: number): void {
  emitWith<OpenTerminal>(OPEN_TERMINAL, {
    id: `recipe:${folderPath}:${i}`,
    title: `recipe ${i}`,
    cwd: folderPath,
    program: "",
    args: [],
    kind: "task",
    init: "seq 1 20000\n",
  });
}

/** Puts a terminal spawned earlier into an endless output loop, by typing at
 *  the prompt its `init` returned to. Reuses the existing tabs rather than
 *  spawning more, so the streaming row measures the same degraded state the
 *  rows before it did, with only the output added. */
function stream(folderPath: string, i: number): void {
  void invoke("pty_write", {
    id: `recipe:${folderPath}:${i}`,
    data: "while true; do seq 1 500; sleep 0.02; done\n",
  }).catch(() => {});
}

/** Clicks `count` tabs of a pane's strip, through the real strip so the measured
 *  path is the one a mouse takes. Scoped to `.unified-strip`: the editor's
 *  right-hand mode tabs are also `[role="tab"]`, and those are not tab
 *  switches. Re-queried every iteration, because activating a tab re-renders
 *  the strip and a node captured beforehand is detached by the next click. */
async function clickTabs(count: number): Promise<void> {
  const strip = () => [...document.querySelectorAll<HTMLElement>('.unified-strip [role="tab"]')];
  traceNote("tab-count", { tabs: strip().length });
  for (let i = 0; i < count; i++) {
    // The first tab that is not already selected: clicking the selected one is
    // a no-op the strip drops before it reaches the activation path.
    const next = strip().find((t) => t.getAttribute("aria-selected") !== "true");
    if (!next) break;
    const painted = nextSpan(4000);
    next.click();
    await painted;
    await sleep(300);
  }
}

// ---- Mismatch pass ---------------------------------------------------------
//
// Every switch the recipe measured before this one was between workspaces of
// the same shape, so the path that disposes a pane subtree, reparents the
// surfaces inside it and re-attaches WebGL had never run under instrumentation.
// This pass makes one worktree two panes and A/Bs it against a one-pane one.
//
// Three things make a green run mean something rather than merely look green:
//
//   * A split with no tab carried into it is closed by App's empty-pane effect
//     and collapsed by the layout layer, so it has to move a terminal across or
//     there is no mismatch at all. `leaves` says which happened.
//   * `reuseNode` exists to avoid disposal, so the positive control watches the
//     *surfaces*: across a real mismatch the stage-host elements are the same
//     objects (reparented) while the pane wrappers around them are different
//     ones (disposed). Pane wrappers differ between a 2-pane and a 1-pane
//     workspace by construction, so asserting on those alone proves nothing.
//   * Geometry changes here by definition, so xterm reflows and CodeMirror
//     re-measures. The scrollback check is therefore a named sentinel line, not
//     a hash of the visible window.

/** The line echoed into the measured terminal, and looked for either side. */
const SENTINEL = "TORI-MISMATCH-SENTINEL";

/** One newline at the head of the opened file: the smallest edit that gives the
 *  buffer a real undo history to survive the switch, and one this pass can undo
 *  exactly, so the tab closes clean rather than into the dirty-buffer confirm. */
const EDIT_MARK = "\n";

/** Extensions the editor puts a CodeMirror view behind. Markdown, SVG and
 *  images are deliberately absent: `editablePathOf` renders those rather than
 *  editing them, so a pane showing one holds no view at all. A repo root is
 *  mostly markdown, so without this the pass opens a README and measures an
 *  empty document that reads zero on every field it compares. */
const EDITABLE = /\.(ts|tsx|js|jsx|json|toml|rs|txt|css|ya?ml)$/i;

type TermState = { found: boolean; length: number; viewportY: number; sentinel: string | null };
type EditorReading = {
  found: boolean;
  scrollTop: number;
  /** The first line on screen, and the criterion for "the reader kept their
   *  place". Not a pixel: a mismatch round has a narrow pane on one side and a
   *  wide one on the other, so the document rewraps between the two readings
   *  (3137px tall against 4649) and every offset in it moves. Same rule the
   *  terminal check follows in refusing byte-identity of its visible window. */
  topLine: number;
  /** Recorded rather than compared: they are what a width change moves, so they
   *  say whether a difference was a rewrap or a lost position. */
  centerLine: number;
  scrollHeight: number;
  anchor: number;
  head: number;
  undo: number;
};
type Reading = {
  termHost: HTMLElement | null;
  editorHost: HTMLElement | null;
  termPane: HTMLElement | null;
  editorPane: HTMLElement | null;
  term: TermState;
  editor: EditorReading;
};

/** Resolved through the lazy edge rather than imported: `@codemirror/commands`
 *  sits behind the editor's code split (src/test/lazyEditorBoundary.test.ts) and
 *  a static edge from here, which App imports eagerly, would drag it into the
 *  main chunk. By the time this is read the pass has already opened a file, so
 *  the chunk is loaded and the import costs nothing. */
let undoDepthOf: ((state: EditorState) => number) | null = null;

const stageHosts = () => [...document.querySelectorAll<HTMLElement>("[data-stage-host]")];
// By dataset rather than an attribute selector: a tab id is a file path, so it
// carries separators a selector would have to be escaped for.
const hostEl = (id: string) => stageHosts().find((el) => el.dataset.stageHost === id) ?? null;
const editorHostEl = () =>
  stageHosts().find((el) => el.dataset.stageHost?.startsWith("editor-stage")) ?? null;
const editorView = () => {
  const host = editorHostEl();
  return host ? EditorView.findFromDOM(host) : null;
};

/** What the editor half of the pass is looking at, for the note it writes when
 *  it cannot find a loaded view. Without this the abort says only that nothing
 *  was found, which is the least useful half of the answer. */
function editorCensus(): Record<string, unknown> {
  return {
    // Document-wide, not host-scoped: an empty view where the text was expected
    // and a loaded one somewhere else are two different faults, and only a scan
    // that can see both tells them apart.
    views: [...document.querySelectorAll<HTMLElement>(".cm-editor")].map((e) => ({
      doc: EditorView.findFromDOM(e)?.state.doc.length ?? -1,
      host: e.closest<HTMLElement>("[data-stage-host]")?.dataset.stageHost ?? null,
      pane: e.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null,
      box: [e.clientWidth, e.clientHeight],
    })),
    editorHosts: stageHosts()
      .filter((el) => el.dataset.stageHost?.startsWith("editor-stage"))
      .map((h) => h.dataset.stageHost),
    tabsInStrip: [...document.querySelectorAll<HTMLElement>("[data-tab-id]")].map(
      (el) => `${el.dataset.tabId}${el.getAttribute("aria-selected") === "true" ? "*" : ""}`,
    ),
  };
}

async function waitFor<T>(poll: () => T | null, ms: number): Promise<T | null> {
  for (let i = 0; i * 100 < ms; i++) {
    const v = poll();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

/** Scrollback, reflow-tolerantly. `length` and `viewportY` are recorded because
 *  they are the shape of the reflow, not because they are expected to hold: a
 *  narrower pane rewraps and both move legitimately. The sentinel is the claim. */
function termState(host: HTMLElement | null): TermState {
  const term = host ? terminalIn(host) : null;
  if (!term) return { found: false, length: -1, viewportY: -1, sentinel: null };
  const buf = term.buffer.active;
  let sentinel: string | null = null;
  // From the end: `echo` puts the marker on the command line as well as in its
  // output, and the output is the later of the two.
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i)?.translateToString(true).trim() ?? "";
    if (line.startsWith(SENTINEL)) {
      sentinel = line;
      break;
    }
  }
  return { found: true, length: buf.length, viewportY: buf.viewportY, sentinel };
}

/** The scroller each host held at the last probe, so a note can say whether a
 *  view was reparented or rebuilt. Two different faults, one symptom. */
const lastScroller = new Map<string, HTMLElement | null>();

/** Every editor host, not the first one, and the view inside each. A split
 *  re-keys the editor's stage host to the pane it lands in, so a reading that
 *  takes whichever host comes first in the DOM can answer about one view while
 *  meaning another. `scrollerSame` false with the document still there is a
 *  rebuilt view rather than a moved one, and a `scrollHeight` of 2^25 is CM6's
 *  placeholder for a view that has not measured yet. */
function editorProbe(): Record<string, unknown>[] {
  return stageHosts()
    .filter((h) => h.dataset.stageHost?.startsWith("editor-stage"))
    .map((host) => {
      const id = host.dataset.stageHost!;
      const view = EditorView.findFromDOM(host);
      const sc = view?.scrollDOM ?? null;
      const probe = {
        hostId: id,
        pane: host.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null,
        doc: view?.state.doc.length ?? -1,
        scrollerSame: !!sc && sc === lastScroller.get(id),
        scrollTop: sc ? Math.round(sc.scrollTop) : -1,
        scrollHeight: sc?.scrollHeight ?? -1,
        clientHeight: sc?.clientHeight ?? -1,
      };
      lastScroller.set(id, sc);
      return probe;
    });
}

function editorState(host: HTMLElement | null): EditorReading {
  const view = host ? EditorView.findFromDOM(host) : null;
  if (!view) {
    return {
      found: false, scrollTop: -1, centerLine: -1, topLine: -1, scrollHeight: -1, anchor: -1, head: -1, undo: -1,
    };
  }
  const sel = view.state.selection.main;
  const el = view.scrollDOM;
  // `documentTop` is where the document starts in viewport coordinates, so the
  // scroller's own top minus it is how far into the document the first visible
  // pixel is, which is what `lineBlockAtHeight` answers in.
  const into = el.getBoundingClientRect().top - view.documentTop;
  const lineAt = (h: number) => view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, h)).from).number;
  return {
    found: true,
    scrollTop: Math.round(el.scrollTop),
    centerLine: lineAt(into + el.clientHeight / 2),
    topLine: lineAt(into),
    scrollHeight: el.scrollHeight,
    anchor: sel.anchor,
    head: sel.head,
    undo: undoDepthOf ? undoDepthOf(view.state) : -1,
  };
}

function read(termId: string): Reading {
  const termHost = hostEl(termId);
  const editorHost = editorHostEl();
  return {
    termHost,
    editorHost,
    termPane: termHost?.closest<HTMLElement>("[data-pane-id]") ?? null,
    editorPane: editorHost?.closest<HTMLElement>("[data-pane-id]") ?? null,
    term: termState(termHost),
    editor: editorState(editorHost),
  };
}

/** A real file in the worktree root, picked the same way on every run so two
 *  runs of one worktree open the same file. */
async function pickFile(folderPath: string): Promise<string | null> {
  type DirEntry = { name: string; path: string; is_dir: boolean };
  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("fs_read_dir", { path: folderPath });
  } catch (e) {
    traceNote("mismatch-abort", { why: `fs_read_dir failed: ${String(e)}` });
    return null;
  }
  // No fallback to "whatever was listed first": opening something the editor
  // renders instead of edits would abort the pass a step later, with a worse
  // message than the one this refusal carries.
  const files = entries.filter((e) => !e.is_dir && !e.name.startsWith("."));
  return files.find((f) => EDITABLE.test(f.name))?.path ?? null;
}

/** Named rather than inlined three times: `a` and `b` are the two worktrees
 *  everywhere else in this pass, so a reading pair must not borrow them. */
const bothViews = (before: Reading, after: Reading) => before.editor.found && after.editor.found;

/** One A -> B -> A round trip, recorded either side. The comparison is on A's
 *  own surfaces across the round trip rather than on one leg, so both
 *  directions of the disposal are exercised by the thing that is checked. */
async function roundTrip(a: Target, b: Target, termId: string, label: string, round: number) {
  const before = read(termId);
  const leavesBefore = host?.leaves() ?? -1;
  await visit(b);
  const leavesAway = host?.leaves() ?? -1;
  await visit(a);
  const after = read(termId);
  traceNote("mismatch-round", {
    label,
    round,
    leavesA: [leavesBefore, host?.leaves() ?? -1],
    leavesB: leavesAway,
    liveWebglContexts: liveWebglContexts(),
    // The positive control: surfaces kept, wrappers rebuilt.
    termHostSame: !!before.termHost && before.termHost === after.termHost,
    editorHostSame: !!before.editorHost && before.editorHost === after.editorHost,
    termPaneSame: !!before.termPane && before.termPane === after.termPane,
    editorPaneSame: !!before.editorPane && before.editorPane === after.editorPane,
    termFound: [before.term.found, after.term.found],
    sentinelKept: !!before.term.sentinel && before.term.sentinel === after.term.sentinel,
    sentinel: [before.term.sentinel, after.term.sentinel],
    termLength: [before.term.length, after.term.length],
    viewportY: [before.term.viewportY, after.term.viewportY],
    // A view missing on either side fails these rather than passing them: a null
    // reading is the loudest result this pass can produce, not an absence of one.
    editorFound: [before.editor.found, after.editor.found],
    editorSelKept:
      bothViews(before, after) &&
      before.editor.anchor === after.editor.anchor &&
      before.editor.head === after.editor.head,
    editorUndoKept: bothViews(before, after) && before.editor.undo === after.editor.undo,
    editorScrollKept: bothViews(before, after) && before.editor.topLine === after.editor.topLine,
    sel: [before.editor.anchor, before.editor.head, after.editor.anchor, after.editor.head],
    undo: [before.editor.undo, after.editor.undo],
    scrollTop: [before.editor.scrollTop, after.editor.scrollTop],
    centerLine: [before.editor.centerLine, after.editor.centerLine],
    topLine: [before.editor.topLine, after.editor.topLine],
    scrollHeight: [before.editor.scrollHeight, after.editor.scrollHeight],
  });
}

async function mismatchPass(units: Target[], rounds: number): Promise<void> {
  // Two pass notes, not one: setting the pass up costs a file open and a pty
  // write, and a switch sitting behind those would put a seconds-long gap
  // inside the pass whose evenness is what says the run did not stall.
  traceNote("pass", { name: "mismatch-setup" });
  const a = units[0];
  const b = units[Math.min(1, units.length - 1)];
  if (a === b) {
    traceNote("mismatch-abort", { why: "one worktree, nothing to A/B against" });
    return;
  }

  await visit(a);
  const termId = `recipe:${a.unit.folderPath}:0`;

  // The recipe imports only OPEN_TERMINAL, so without this there is no editor
  // view in the run at all and an editor check would measure nothing.
  const file = await pickFile(a.unit.folderPath);
  if (!file) {
    traceNote("mismatch-abort", { why: `no editable file in ${a.unit.folderPath}` });
    return;
  }
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: file });
  // Opening the file is not enough to put it on screen. A pane's stored pick
  // outranks a kind's claim (`activeIdInPane`), and the tab-clicks pass just
  // stored a terminal in this pane, so the file lands in the strip behind it.
  // Clicking its tab is what a user does and what writes the pane's pick.
  const tab = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>(".unified-strip [data-tab-id]")].find(
        (el) => el.dataset.tabId === file,
      ) ?? null,
    5000,
  );
  if (!tab) {
    traceNote("mismatch-abort", { why: `no strip tab for ${file}`, ...editorCensus() });
    return restoreMismatch(termId, null);
  }
  tab.click();
  // A view appears before its text does, and a view over an empty document reads
  // zero on every field this pass compares, which is a green that means nothing.
  // So the wait is for the text, not for the view.
  const view = await waitFor(() => {
    const v = editorView();
    return v && v.state.doc.length > 0 ? v : null;
  }, 8000);
  if (!view) {
    traceNote("mismatch-abort", {
      why: `no loaded editor view after opening ${file}`,
      ...editorCensus(),
    });
    // The tab may still have opened, and a stray one would move the end census.
    return restoreMismatch(termId, null);
  }
  undoDepthOf = (await import("@codemirror/commands")).undoDepth;
  // Selection and scroll well away from the origin, and a document edit, so all
  // three editor readings can tell a kept state from a rebuilt one. A rebuilt
  // state would read zero on every one of them, which is why none of these may
  // be left at zero.
  //
  // And scrolled away from the caret rather than onto it, in a second dispatch:
  // a view that comes back by centring the caret and one that comes back to
  // where the reader was are otherwise the same number, so the two would have
  // been indistinguishable and the check would have passed either way.
  const at = Math.floor(view.state.doc.length * 0.6);
  // Floored at 1, not 10% flat: on a short file 10% rounds to 0, and a caret at
  // 0 would make the selection check compare zero against zero - the exact
  // reading this pass exists to refuse.
  const caret = Math.max(1, Math.floor(view.state.doc.length * 0.1));
  view.dispatch({ changes: { from: 0, insert: EDIT_MARK } });
  view.dispatch({ selection: { anchor: Math.max(0, caret - 20), head: caret } });
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
  await sleep(500);
  traceNote("mismatch-file", {
    path: file,
    docLength: view.state.doc.length,
    ...editorState(editorHostEl()),
    probe: editorProbe(),
  });

  void invoke("pty_write", { id: termId, data: `echo ${SENTINEL}\n` }).catch(() => {});
  traceNote("mismatch-sentinel", { tabId: termId, text: SENTINEL });
  await sleep(GAP_MS);

  // Same-shape control first, on the same surfaces the mismatch rounds measure,
  // so one run says what "kept" and "rebuilt" look like side by side. Its own
  // pass name, so the summary does not average the two shapes into one row.
  traceNote("pass", { name: "mismatch-control" });
  await roundTrip(a, b, termId, "control", 0);

  const basePane = read(termId).termPane?.dataset.paneId ?? null;
  emitWith<SplitPane>(SPLIT_PANE, { dir: "row", tabId: termId, kind: "task" });
  await sleep(GAP_MS);
  const split = host?.leaves() ?? -1;
  // The editor read again here, not only either side of a switch: the split is
  // itself a reparent, so a field that is already gone by this line was lost to
  // the split rather than to the mismatch rounds that follow, and a round
  // comparing zero against zero would otherwise report holding what it lost.
  traceNote("mismatch-split", {
    termId,
    basePane,
    leaves: split,
    editor: editorState(editorHostEl()),
    probe: editorProbe(),
    ...counts(),
  });
  if (split < 2) {
    traceNote("mismatch-abort", { why: `split did not survive, leaves=${split}` });
  } else {
    traceNote("pass", { name: "mismatch", rounds });
    for (let r = 0; r < rounds; r++) await roundTrip(a, b, termId, "mismatch", r);
  }

  await restoreMismatch(termId, basePane);
  // Leave the selection where the passes before this one left it. The streaming
  // pass opens by visiting A, and re-selecting the worktree already shown opens
  // no span, so ending on A costs that pass one of its six samples. Its own pass
  // name, so this tidying switch is not counted into the mismatch row.
  traceNote("pass", { name: "mismatch-restore" });
  await visit(b);
}

/** Put back what the pass changed, so the streaming rows and the end census see
 *  the state every earlier run left them. The emptied pane is not closed here:
 *  App's empty-pane effect collapses a pane that has held a tab and lost it, and
 *  the leaf count below is what says it did. */
async function restoreMismatch(termId: string, basePane: string | null): Promise<void> {
  if (basePane) {
    emitWith<MoveTabToPane>(MOVE_TAB_TO_PANE, { tabId: termId, kind: "task", paneId: basePane });
    await sleep(GAP_MS);
  }
  // Undoing the edit by rewriting exactly what it inserted, rather than through
  // the history: the buffer is dirty against disk until the text matches again,
  // and a dirty tab closes into a confirm nothing in a scripted run can answer.
  // Guarded on the text still being there, so a state that came back from disk
  // is left alone rather than having its first character deleted.
  const view = editorView();
  if (view && view.state.doc.sliceString(0, EDIT_MARK.length) === EDIT_MARK) {
    view.dispatch({ changes: { from: 0, to: EDIT_MARK.length, insert: "" } });
  }
  await sleep(300);
  emit(EDITOR_CLOSE_TAB);
  await sleep(GAP_MS);
  traceNote("mismatch-restored", { leaves: host?.leaves() ?? -1, ...counts() });
}

/** The two multipliers the plan wants confirmed at runtime. Class names are
 *  CSS-module-hashed, so these match on a substring; the canvas count stands in
 *  for live WebGL contexts, which the platform will not report directly. */
function counts(): Record<string, number> {
  const q = (s: string) => document.querySelectorAll(s).length;
  return {
    terminalHosts: q('[class*="termHostWrap"]'),
    visibleTerminalHosts: q('[class*="termHostWrap"]:not([class*="hidden"])'),
    xtermCanvases: q(".xterm-screen canvas"),
    liveWebglContexts: liveWebglContexts(),
    tabs: q('[role="tab"]'),
  };
}

/** What the WebGL cap is actually capping. The canvas count above cannot say:
 *  an attached renderer puts two canvases in the host (its own and a 2d link
 *  layer), so the total moves for reasons other than a context appearing.
 *  `getContext` on a canvas that already has a 2d context answers null rather
 *  than making a second one, so nothing here creates the thing it counts. */
function liveWebglContexts(): number {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")];
  return canvases.filter((c) => {
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
    return !!gl && !gl.isContextLost();
  }).length;
}

async function quit(): Promise<void> {
  traceFlush();
  await sleep(400);
  // `destroy`, not `close`: close re-enters the editor's dirty-buffer confirm
  // and would hang on a dialog nobody can answer. Destroying the window leaves
  // the process up (PTY and chat hosts), so the backend is asked to exit too.
  await getCurrentWindow().destroy().catch(() => {});
  await invoke("trace_quit").catch(() => {});
}
