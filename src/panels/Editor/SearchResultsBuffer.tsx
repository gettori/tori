import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import { Annotation, EditorState, StateEffect, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import Button from "../../components/Button/Button";
import { markSelfWrite } from "../../utils/selfWrites";
import { adoptBufferText, dirtyBuffers, liveBufferText, patchBuffer } from "./liveBuffers";
import { searchBuffer } from "./searchResultsStore";
import {
  collectEdits,
  describeApply,
  refusalFor,
  renderLines,
  settle,
  type ApplyOutcome,
  type FileEdits,
  type SearchDoc,
} from "./searchResultsDoc";
import styles from "./SearchResultsBuffer.module.css";

/** What `apply_line_edits` reports back. */
type ApplyResult = { changed: string[]; skipped: { path: string; reason: string }[] };

/** The buffer's own rewrites (the file headers, after an apply marks them).
 *  Carried on the transaction so the guard lets it through: it is the one edit
 *  allowed to touch a header row, and it is not a user edit at all. */
const REWRITE = Annotation.define<boolean>();

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
async function writeBack(root: string, groups: FileEdits[]): Promise<ApplyOutcome> {
  const written: string[] = [];
  const inBuffer: string[] = [];
  const refused: { file: string; reason: string }[] = [];
  const toDisk: FileEdits[] = [];

  for (const group of groups) {
    const abs = `${root}/${group.path}`;
    if (!dirtyBuffers([abs]).length) {
      toDisk.push(group);
      continue;
    }
    const outcome = patchBuffer(abs, group.edits);
    if (outcome === "applied") inBuffer.push(group.path);
    else {
      refused.push({
        file: group.path,
        reason: outcome === "stale" ? "changed since the search" : "no longer open",
      });
    }
  }

  if (toDisk.length) {
    // Marked twice, as the cross-file rename is: once to cover an echo that
    // arrives while the batch is still writing, and once from the moment it
    // finished, so the watcher's own debounce still lands inside the window.
    // The second pass names only what was written, so a refused file does not
    // keep a genuine external edit suppressed.
    for (const group of toDisk) markSelfWrite(`${root}/${group.path}`);
    const out = await invoke<ApplyResult>("apply_line_edits", { root, files: toDisk });
    for (const rel of out.changed) markSelfWrite(`${root}/${rel}`);
    written.push(...out.changed);
    refused.push(...out.skipped.map((s) => ({ file: s.path, reason: s.reason })));
    for (const rel of out.changed) {
      const abs = `${root}/${rel}`;
      if (liveBufferText(abs) === null) continue;
      const text = await invoke<string>("fs_read_file", { path: abs }).catch(() => null);
      if (text !== null) adoptBufferText(abs, text);
    }
  }

  return { written, inBuffer, refused };
}

/**
 * Every match in the project as one editable buffer, with a write-back.
 *
 * Its own CodeMirror instance rather than a buffer inside `CodeEditor`: this
 * document has no file behind it, needs no language server, and lives under
 * rules no file buffer has (see `searchResultsDoc.ts`). The document itself is
 * held by `searchResultsStore`, because the Editor unmounts a synthetic tab's
 * view the moment another tab is selected.
 */
export default function SearchResultsBuffer(props: { id: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const [pending, setPending] = createSignal(0);
  const [outcome, setOutcome] = createSignal<string | null>(null);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);

  const entry = () => searchBuffer(props.id);

  function countPending() {
    const e = entry();
    if (!e || !view) return setPending(0);
    setPending(collectEdits(e.doc, view.state.doc.toJSON()).length);
  }

  /** Repaint the rows whose *rendered* text has moved (the file headers, after
   *  an apply marks them). Line by line and never a whole-document replace, so
   *  the selection and the undo history survive being told what happened. */
  function repaint() {
    const e = entry();
    if (!e || !view) return;
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
    if (!e || !view || applying()) return;
    const lines = view.state.doc.toJSON();
    const groups = collectEdits(e.doc, lines);
    if (!groups.length) return;
    setApplying(true);
    setRefusal(null);
    try {
      const out = await writeBack(e.doc.root, groups);
      e.doc = settle(e.doc, lines, out);
      repaint();
      setOutcome(describeApply(out));
    } catch (err) {
      setOutcome(`Could not write back: ${String(err)}`);
    } finally {
      setApplying(false);
      countPending();
    }
  }

  function build(id: string) {
    const e = searchBuffer(id);
    if (!e) return;
    const extensions = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
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
      guardEdits(
        () => searchBuffer(id)?.doc ?? e.doc,
        (why) => setRefusal(why),
      ),
      // While a write is in flight the document has to hold still: `apply`
      // settles the buffer it snapshotted against what comes back, so a
      // keystroke landing in between would leave a row locked as written back
      // while showing text that was never written.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || tr.annotation(REWRITE) || !applying()) return tr;
        setRefusal("Still writing the last apply back.");
        return [];
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
    const kept = e.state;
    view = new EditorView({
      state: kept ?? EditorState.create({ doc: renderLines(e.doc).join("\n"), extensions }),
      parent: host,
    });
    // A state carries the configuration it was built with, and the one this
    // buffer left behind on the last tab switch closes over a view that has
    // since been destroyed and signals nothing renders any more. Reconfiguring
    // keeps the document, the selection and the undo history while pointing
    // every extension at the mount that is on screen now.
    if (kept) view.dispatch({ effects: StateEffect.reconfigure.of(extensions) });
    e.state = view.state;
    countPending();
  }

  function teardown(id: string) {
    const e = searchBuffer(id);
    if (e && view) e.state = view.state;
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
        setOutcome(null);
        setRefusal(null);
        build(id);
      },
    ),
  );
  onCleanup(() => teardown(props.id));

  return (
    <div class={styles.resultsBuffer}>
      <div class={styles.headerBar}>
        <span class={styles.query}>{entry()?.doc.query ?? ""}</span>
        {/* Always rendered, empty or not: it is what holds the Apply button
            against the right edge whether or not there is an outcome to show. */}
        <span class={styles.meta}>{outcome() ?? ""}</span>
        <Button
          size="xs"
          disabled={!pending() || applying()}
          tooltipWhenDisabled
          tooltip={
            pending()
              ? "Write every edited line back to the file it came from"
              : "Edit a result line first"
          }
          onClick={() => void apply()}
        >
          {pending() ? `Apply to ${pending()} ${pending() === 1 ? "file" : "files"}` : "Apply"}
        </Button>
      </div>
      <Show when={refusal()}>
        <div class={styles.refusal} role="status">
          {refusal()}
        </div>
      </Show>
      <Show
        when={entry()}
        fallback={<div class="tree-empty">This results buffer is gone. Run the search again.</div>}
      >
        <div class={styles.editorHost} ref={host} />
      </Show>
    </div>
  );
}
