import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, type DecorationSet } from "@codemirror/view";
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Ellipsis, RefreshCw, Rows3 } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import { markSelfWrite } from "../../utils/selfWrites";
import { debounce } from "../../utils/debounce";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import type { MemberRoot, TintedMember } from "../../utils/topicMembers";
import {
  countOccurrences,
  mergeSearchResults,
  openUnder,
  truncationNotice,
  type RootOutcome,
  type SearchOptions,
  type ToggleKey,
} from "../../utils/searchOptions";
import { adoptBufferText, dirtyBuffers, liveBufferText, patchBuffer } from "./liveBuffers";
import { noteSearchQuery, searchBuffer, type EditorForm } from "./searchResultsStore";
import { grepRoot, MAX_RESULTS, readHitFiles } from "./searchRun";
import { Field, GlobFields, MatchToggles } from "./SearchFields";
import {
  buildSearchDoc,
  collectEdits,
  describeApply,
  prefixLen,
  refusalFor,
  renderLines,
  settle,
  type ApplyOutcome,
  type DocFile,
  type DocRoot,
  type FileEdits,
  type ResultMatch,
  type SearchDoc,
} from "./searchResultsDoc";
import styles from "./SearchResultsBuffer.module.css";

/** What `apply_line_edits` reports back. */
type ApplyResult = { changed: string[]; skipped: { path: string; reason: string }[] };

/** The buffer's own rewrites (the file headers, after an apply marks them).
 *  Carried on the transaction so the guard lets it through: it is the one edit
 *  allowed to touch a header row, and it is not a user edit at all. */
const REWRITE = Annotation.define<boolean>();

const EMPTY_DOC: SearchDoc = { roots: [], query: "", rows: [], width: 1, marks: {} };

/**
 * Refuse any edit the line map could not survive, and say why.
 *
 * A filter rather than a set of read-only ranges: the buffer has to *tell* the
 * user, since an editor that silently swallows a keystroke reads as broken.
 * `doc` is a getter because the marks move under it on every apply.
 */
function guardEdits(doc: () => SearchDoc, refuse: (why: string) => void): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(REWRITE)) return tr;
    const why = refusalFor(doc(), tr.startState, tr.changes);
    if (!why) return tr;
    refuse(why);
    return [];
  });
}

const LINE_CLASS: Record<string, string> = {
  note: "sr-note",
  member: "sr-member",
  file: "sr-file",
  context: "sr-context",
};

/** Row styling and hit highlights, built from the rows once per document and
 *  then carried along by the edits. */
function rowDecorations(doc: () => SearchDoc): Extension {
  const build = (state: EditorState): DecorationSet => {
    const d = doc();
    const b = new RangeSetBuilder<Decoration>();
    const lead = prefixLen(d);
    d.rows.forEach((row, i) => {
      if (i >= state.doc.lines) return;
      const line = state.doc.line(i + 1);
      const cls = LINE_CLASS[row.kind];
      if (cls) b.add(line.from, line.from, Decoration.line({ class: cls }));
      if (row.kind !== "match" && row.kind !== "context") return;
      b.add(line.from, Math.min(line.to, line.from + lead), Decoration.mark({ class: "sr-lineno" }));
      if (row.kind !== "match") return;
      for (const [s, e] of row.spans ?? []) {
        const from = line.from + lead + s;
        const to = line.from + lead + e;
        if (to <= line.to && to > from) b.add(from, to, Decoration.mark({ class: "sr-hit" }));
      }
    });
    return b.finish();
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => deco.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Send one apply's edits where each file's edits belong.
 *
 * A file with **unsaved edits** takes them in its buffer and is not written:
 * disk is not the copy the user is looking at, and writing it would either be
 * reverted by their next save or raise a reload banner over an edit they just
 * asked for.
 *
 * Everything else is written by the backend, and then the two calls a
 * cross-file rename makes: mark the write as ours so the watcher's echo does
 * not read as somebody else's edit, and hand the new bytes to any buffer
 * holding that file so it agrees with what is now on disk. Both halves are
 * needed together - marking without adopting is exactly the trade the Search
 * panel's replace refuses to make, because it leaves a clean tab showing
 * pre-write text whose next save reverts the write.
 */
async function writeBack(groups: FileEdits[]): Promise<ApplyOutcome> {
  const written: DocFile[] = [];
  const inBuffer: DocFile[] = [];
  const refused: (DocFile & { reason: string })[] = [];
  // `apply_line_edits` takes one root, so the batch is split by member and each
  // part is sent against its own. Grouped rather than one call per file so a
  // member still writes in a single command, as it always did.
  const toDisk = new Map<string, FileEdits[]>();

  for (const group of groups) {
    const abs = `${group.root}/${group.path}`;
    if (!dirtyBuffers([abs]).length) {
      const here = toDisk.get(group.root);
      if (here) here.push(group);
      else toDisk.set(group.root, [group]);
      continue;
    }
    const outcome = patchBuffer(abs, group.edits);
    if (outcome === "applied") inBuffer.push({ root: group.root, file: group.path });
    else {
      refused.push({
        root: group.root,
        file: group.path,
        reason: outcome === "stale" ? "changed since the search" : "no longer open",
      });
    }
  }

  for (const [root, files] of toDisk) {
    // Marked twice, as the cross-file rename is: once to cover an echo that
    // arrives while the batch is still writing, and once from the moment it
    // finished, so the watcher's own debounce still lands inside the window.
    // The second pass names only what was written, so a refused file does not
    // keep a genuine external edit suppressed.
    for (const group of files) markSelfWrite(`${root}/${group.path}`);
    const out = await invoke<ApplyResult>("apply_line_edits", {
      root,
      // The root is stripped: it is this call's argument, and the backend's
      // per-file struct has no field for it.
      files: files.map(({ path, edits }) => ({ path, edits })),
    });
    for (const rel of out.changed) markSelfWrite(`${root}/${rel}`);
    written.push(...out.changed.map((file) => ({ root, file })));
    refused.push(...out.skipped.map((s) => ({ root, file: s.path, reason: s.reason })));
    for (const rel of out.changed) {
      const abs = `${root}/${rel}`;
      if (liveBufferText(abs) === null) continue;
      const text = await invoke<string>("fs_read_file", { path: abs }).catch(() => null);
      if (text !== null) adoptBufferText(abs, text);
    }
  }

  return { written, inBuffer, refused };
}

const CONTEXT_MAX = 99;

/** How many lines to show around each hit: a small field between a minus and a
 *  plus, sized to sit in the query row. */
function ContextStepper(props: { value: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.max(0, Math.min(CONTEXT_MAX, Math.round(v) || 0));
  const set = (v: number) => props.onChange(clamp(v));
  return (
    <div class={styles.stepper}>
      <button
        type="button"
        class={styles.stepperBtn}
        aria-label="Fewer context lines"
        disabled={props.value <= 0}
        onClick={() => set(props.value - 1)}
      >
        -
      </button>
      <input
        class={styles.stepperNum}
        type="number"
        min="0"
        max={CONTEXT_MAX}
        aria-label="Context lines"
        value={props.value}
        onChange={(e) => {
          // Rewritten in place, or a clamped entry that lands on the current
          // value leaves the typed text showing.
          const v = clamp(Number(e.currentTarget.value));
          e.currentTarget.value = String(v);
          props.onChange(v);
        }}
      />
      <button
        type="button"
        class={styles.stepperBtn}
        aria-label="More context lines"
        disabled={props.value >= CONTEXT_MAX}
        onClick={() => set(props.value + 1)}
      >
        +
      </button>
    </div>
  );
}

const HELD = "Edits not applied yet. Apply them, or press Enter to search again and drop them.";

/**
 * VS Code's Search Editor: a tab with its own query, toggles, globs and context
 * lines over every hit as one buffer, plus Tori's write-back of edited lines.
 *
 * Its own CodeMirror instance rather than a buffer inside `CodeEditor`: this
 * document has no file behind it, needs no language server, and lives under
 * rules no file buffer has (see `searchResultsDoc.ts`). The state is held by
 * `searchResultsStore`, because the Editor unmounts a synthetic tab's view the
 * moment another tab is selected.
 */
export default function SearchResultsBuffer(props: {
  id: string;
  /** Every root the workspace searches, one per Topic member. */
  roots: MemberRoot[];
  /** Empty outside a Topic. */
  members: readonly TintedMember[];
  /** Absolute paths of the files open in editor tabs. */
  openPaths: readonly string[];
  confirm?: (opts: { title: string; message?: string; confirmLabel?: string }) => Promise<boolean>;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let queryEl: HTMLInputElement | undefined;
  const [pending, setPending] = createSignal(0);
  const [outcome, setOutcome] = createSignal<string | null>(null);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [held, setHeld] = createSignal(false);
  const [form, setForm] = createSignal<EditorForm | null>(null);
  const [details, setDetails] = createSignal(false);
  const [caps, setCaps] = createSignal<{ backend: string; unsupported: string[] }>({ backend: "", unsupported: [] });
  const [hasDoc, setHasDoc] = createSignal(false);

  const entry = () => searchBuffer(props.id);
  const status = () => refusal() ?? (held() ? HELD : outcome() ?? "");
  const docOf = () => searchBuffer(props.id)?.doc ?? EMPTY_DOC;

  function countPending() {
    const e = entry();
    if (!e?.doc || !view) return setPending(0);
    setPending(collectEdits(e.doc, view.state.doc.toJSON()).length);
  }

  /** Repaint the rows whose *rendered* text has moved (the file headers, after
   *  an apply marks them). Line by line and never a whole-document replace, so
   *  the selection and the undo history survive being told what happened. */
  function repaint() {
    const e = entry();
    if (!e?.doc || !view) return;
    const doc = view.state.doc;
    const next = renderLines(e.doc, doc.toJSON());
    const changes: { from: number; to: number; insert: string }[] = [];
    next.forEach((text, i) => {
      const line = doc.line(i + 1);
      if (line.text !== text) changes.push({ from: line.from, to: line.to, insert: text });
    });
    if (changes.length) view.dispatch({ changes, annotations: REWRITE.of(true) });
  }

  async function apply() {
    const e = entry();
    if (!e?.doc || !view || applying()) return;
    const lines = view.state.doc.toJSON();
    const groups = collectEdits(e.doc, lines);
    if (!groups.length) return;
    setApplying(true);
    setRefusal(null);
    try {
      const out = await writeBack(groups);
      e.doc = settle(e.doc, lines, out);
      repaint();
      setOutcome(describeApply(e.doc, out));
    } catch (err) {
      setOutcome(`Could not write back: ${String(err)}`);
    } finally {
      setApplying(false);
      countPending();
    }
  }

  function openRow(line: number) {
    const row = docOf().rows[line - 1];
    if (!row || (row.kind !== "file" && row.kind !== "match" && row.kind !== "context")) return false;
    const at = row.kind === "file" ? undefined : row.line;
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: `${row.root}/${row.file}`, line: at });
    return true;
  }

  function extensionsFor(id: string): Extension[] {
    const doc = () => searchBuffer(id)?.doc ?? EMPTY_DOC;
    return [
      history(),
      drawSelection(),
      highlightActiveLine(),
      // CodeMirror gives its content `role="textbox"`, so without this the pane
      // is an ARIA input field with no accessible name. Same defect axe found in
      // ConflictView, and the same fix.
      EditorView.contentAttributes.of({ "aria-label": "Search results, editable" }),
      // Save is what applying *is* here, and Cmd+S is nobody else's: the
      // binding table deliberately leaves it to whichever editor has focus.
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void apply();
            return true;
          },
        },
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      guardEdits(doc, (why) => setRefusal(why)),
      // While a write is in flight the document has to hold still: `apply`
      // settles the buffer it snapshotted against what comes back, so a
      // keystroke landing in between would leave a row locked as written back
      // while showing text that was never written.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || tr.annotation(REWRITE) || !applying()) return tr;
        setRefusal("Still writing the last apply back.");
        return [];
      }),
      rowDecorations(doc),
      EditorView.domEventHandlers({
        dblclick: (ev, v) => {
          const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
          return pos !== null && openRow(v.state.doc.lineAt(pos).number);
        },
      }),
      EditorView.updateListener.of((u) => {
        const live = searchBuffer(id);
        if (live) live.state = u.state;
        if (u.docChanged) {
          countPending();
          // An edit that got through has answered whatever the last one was
          // refused for, and a complaint that outlives its keystroke reads as
          // one about the edit that just worked.
          setRefusal(null);
        }
      }),
    ];
  }

  /** A fresh document: new state, new undo history, nothing pending. */
  function showDoc() {
    const e = entry();
    if (!e || !view) return;
    view.setState(
      EditorState.create({ doc: e.doc ? renderLines(e.doc).join("\n") : "", extensions: extensionsFor(props.id) }),
    );
    e.state = view.state;
    setHasDoc(!!e.doc);
    setRefusal(null);
    countPending();
  }

  async function buildFrom(matches: ResultMatch[], roots: DocRoot[], f: EditorForm) {
    const context =
      f.showContext && f.context > 0 ? { lines: f.context, textOf: await readHitFiles(matches) } : undefined;
    return buildSearchDoc(roots, f.query, matches, context);
  }

  const labelOf = (root: string) => props.roots.find((r) => r.path === root)?.label || root;

  let runGen = 0;
  /** Search with the form as it stands. With edits waiting, a search by typing
   *  holds off; Enter asks before dropping them. */
  async function run(how: "auto" | "ask" = "auto") {
    const e = entry();
    const f = form();
    if (!e || !f) return;
    e.form = f;
    if (pending()) {
      if (how === "auto") return setHeld(true);
      const ok = props.confirm
        ? await props.confirm({
            title: "Drop the edits you have not applied?",
            message: "Searching again rebuilds this buffer from disk.",
            confirmLabel: "Search",
          })
        : true;
      if (!ok) return;
    }
    setHeld(false);
    noteSearchQuery(props.id, f.query);
    const gen = ++runGen;
    if (!f.query) {
      e.doc = null;
      setOutcome(null);
      return showDoc();
    }
    const roots = props.roots.filter((r) => r.state?.usable !== false);
    setRunning(true);
    try {
      const legs = await Promise.all(
        roots.map((r): Promise<RootOutcome> => {
          const only = f.openOnly ? openUnder(r.path, props.openPaths) : undefined;
          if (only && !only.length) {
            return Promise.resolve({
              root: r.path,
              result: { matches: [], truncated: false, backend: "", unsupported: [], files: [] },
            });
          }
          return grepRoot(r.path, f.query, { ...f.options, only });
        }),
      );
      if (gen !== runGen) return;
      const merged = mergeSearchResults(legs);
      const answered = merged.sections.find((s) => s.backend);
      setCaps({ backend: answered?.backend ?? "", unsupported: merged.unsupported });
      const failed = merged.sections.filter((s) => s.error);
      const matches = merged.sections.flatMap((s) => s.matches.map((m) => ({ ...m, root: s.root })));
      const doc = await buildFrom(matches, roots.map((r) => ({ root: r.path, label: labelOf(r.path) })), f);
      if (gen !== runGen) return;
      e.doc = doc;
      showDoc();
      const notes = merged.sections
        .map((s) => truncationNotice(s.truncated, MAX_RESULTS, countOccurrences(s.matches)))
        .filter(Boolean);
      setOutcome([...failed.map((s) => s.error), ...notes].join(" ") || null);
    } finally {
      if (gen === runGen) setRunning(false);
    }
  }
  const runSoon = debounce(() => void run(), 300);

  function edit(patch: Partial<EditorForm>, now = true) {
    setForm((f) => (f ? { ...f, ...patch } : f));
    if (now) {
      runSoon.cancel();
      void run();
    } else runSoon();
  }
  const setOption = (patch: Partial<SearchOptions>, now = true) => {
    const f = form();
    if (f) edit({ options: { ...f.options, ...patch } }, now);
  };

  async function mount(id: string) {
    const e = searchBuffer(id);
    setForm(e ? { ...e.form } : null);
    setDetails(!!e && !!(e.form.options.include || e.form.options.exclude || e.form.openOnly));
    setOutcome(null);
    setRefusal(null);
    setHeld(false);
    if (!e) return;
    const kept = e.state;
    const extensions = extensionsFor(id);
    view = new EditorView({
      state: kept ?? EditorState.create({ doc: e.doc ? renderLines(e.doc).join("\n") : "", extensions }),
      parent: host,
    });
    // A state carries the configuration it was built with, and the one this
    // buffer left behind on the last tab switch closes over a view that has
    // since been destroyed. Reconfiguring keeps the document, the selection and
    // the undo history while pointing every extension at this mount.
    if (kept) view.dispatch({ effects: StateEffect.reconfigure.of(extensions) });
    e.state = view.state;
    setHasDoc(!!e.doc);
    countPending();
    if (e.seed && !e.doc) {
      const seed = e.seed;
      e.seed = null;
      setRunning(true);
      e.doc = await buildFrom(seed.matches, seed.roots, e.form);
      setRunning(false);
      if (searchBuffer(id) === e && props.id === id) showDoc();
    } else if (!e.doc && e.form.query) {
      void run();
    }
    if (!e.form.query) requestAnimationFrame(() => queryEl?.focus());
  }

  function teardown(id: string) {
    const e = searchBuffer(id);
    if (e && view) e.state = view.state;
    const f = form();
    if (e && f) e.form = f;
    runSoon.cancel();
    runGen++;
    view?.destroy();
    view = undefined;
  }

  // The tab strip reuses this component when you switch from one search tab to
  // another, so the id is a dependency rather than a one-time read: an effect,
  // not `onMount`. The outgoing buffer's state goes back to the store first, or
  // switching tabs would be the one way to lose edits.
  createEffect(
    on(
      () => props.id,
      (id, prev) => {
        if (prev !== undefined) teardown(prev);
        void mount(id);
      },
    ),
  );
  onCleanup(() => teardown(props.id));

  return (
    <div class={styles.resultsBuffer}>
      <Show when={form()} fallback={<div class="tree-empty">This search is gone. Open a new one from Search.</div>}>
        {(f) => (
          <div class={styles.form}>
            <div class={styles.queryRow}>
              <Field
                ref={(el) => (queryEl = el)}
                value={f().query}
                label="Search"
                placeholder="Search"
                onInput={(v) => edit({ query: v }, false)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  runSoon.cancel();
                  void run("ask");
                }}
              >
                <MatchToggles
                  options={f().options}
                  unsupported={caps().unsupported}
                  backend={caps().backend}
                  onToggle={(k: ToggleKey) => setOption({ [k]: !f().options[k] })}
                />
              </Field>
              <ContextStepper value={f().context} onChange={(context) => edit({ context, showContext: true })} />
              <IconButton
                icon={<Icon icon={Rows3} />}
                class={styles.pressable}
                aria-pressed={f().showContext}
                tooltip="Toggle Context Lines"
                onClick={() => edit({ showContext: !f().showContext })}
              />
              <IconButton
                icon={<Icon icon={RefreshCw} />}
                tooltip="Search Again"
                disabled={running()}
                onClick={() => void run("ask")}
              />
              <IconButton
                icon={<Icon icon={Ellipsis} />}
                class={styles.pressable}
                aria-pressed={details()}
                aria-expanded={details()}
                tooltip="Toggle Search Details"
                onClick={() => setDetails((v) => !v)}
              />
            </div>
            <Show when={status() || pending() || applying()}>
              <div class={styles.statusRow}>
                <span class={styles.meta} role="status">
                  {status()}
                </span>
                <Show when={pending() || applying()}>
                  <Button
                    size="xs"
                    disabled={applying()}
                    tooltip="Write every edited line back to the file it came from"
                    onClick={() => void apply()}
                  >
                    {`Apply to ${pending()} ${pending() === 1 ? "file" : "files"}`}
                  </Button>
                </Show>
              </div>
            </Show>
            <Show when={details()}>
              <GlobFields
                options={f().options}
                unsupported={caps().unsupported}
                backend={caps().backend}
                openOnly={f().openOnly}
                onGlob={(k, v) => setOption({ [k]: v }, false)}
                onOpenOnly={() => edit({ openOnly: !f().openOnly })}
                onToggleIgnore={() => setOption({ noIgnore: !f().options.noIgnore })}
              />
            </Show>
          </div>
        )}
      </Show>
      <div class={styles.editorHost} classList={{ [styles.blank]: !hasDoc() }} ref={host} />
      <Show when={form() && !hasDoc()}>
        <div class={styles.blankHint}>{running() ? "Searching..." : "Type to search. Double-click a result to open it."}</div>
      </Show>
    </div>
  );
}
