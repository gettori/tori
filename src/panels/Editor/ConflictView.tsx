import { createSignal, createMemo, createEffect, on, onCleanup, batch, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { gitState } from "../../utils/gitActions";
import { EditorView, lineNumbers, showPanel, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, RangeSetBuilder, Text, type Extension } from "@codemirror/state";
import { MergeView } from "@codemirror/merge";
import {
  conflictRegions,
  conflictsOnly,
  nextConflict,
  prevConflict,
  sideLabels,
  type ConflictOp,
  type ConflictRegion,
  type ConflictStages,
} from "../../utils/conflict";
import Button from "../../components/Button/Button";
import styles from "./ConflictView.module.css";

/** What the operation is called in the header. `none` is where a conflicted
 *  `git stash apply` or `git checkout -m` lands: git records no state for
 *  either, but the tree is just as unmerged. */
const OP_WORD: Record<ConflictOp, string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherrypick: "Cherry-pick",
  revert: "Revert",
  none: "Unresolved",
};

// Its own theme rather than CodeEditor's: that module is the lazy edge of the
// whole editing stack (language packs, LSP), and two read-only panes need none
// of it. No syntax highlighting either - what matters here is which lines the
// two sides disagree about, and the merge view already colours exactly that.
const paneTheme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--canvas-card)", color: "var(--fg-default)" },
    ".cm-content": {
      fontFamily: 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)',
      fontSize: "var(--editor-font-size, 13px)",
    },
    ".cm-gutters": { backgroundColor: "var(--canvas-card)", color: "var(--fg-subtle)", border: "none" },
    ".cm-activeLine": { backgroundColor: "transparent" },
  },
  { dark: true },
);

/**
 * Line decorations for one side of the model.
 *
 * The part a two-document view cannot do for itself: `MergeView` knows ours and
 * theirs differ, but only the base says whether that is a conflict (both sides
 * moved) or a change to carry across (one side did). So the merge view colours
 * the text, and this colours the line it sits on.
 */
export function regionDecorations(
  regions: ConflictRegion[],
  side: "ours" | "theirs",
  doc: Text,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of regions) {
    const { from, to } = r[side];
    for (let n = from; n < to; n++) {
      // A range can name a line past the end when a side ends without a
      // trailing newline. The range is still right; there is simply no line
      // there to decorate.
      if (n < 1 || n > doc.lines) continue;
      builder.add(
        doc.line(n).from,
        doc.line(n).from,
        Decoration.line({ class: r.both ? styles.conflictLine : styles.carriedLine }),
      );
    }
  }
  return builder.finish();
}

function paneExtensions(
  regions: ConflictRegion[],
  side: "ours" | "theirs",
  doc: Text,
  label: string,
): Extension {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    paneTheme,
    // Computed once and held: both documents are read-only, so there are no
    // changes for a decoration set to be mapped through.
    EditorView.decorations.of(regionDecorations(regions, side, doc)),
    // The name sits *inside* its pane rather than in a row above the pair. Two
    // columns laid over the merge view line up only while the panes are exactly
    // half each, which stops being true the moment Phase 12 turns on revert
    // controls; a panel cannot drift away from the document it names.
    showPanel.of(() => {
      const dom = document.createElement("div");
      dom.className = styles.sideLabel;
      dom.textContent = label;
      return { dom, top: true };
    }),
  ];
}

/** Put line `line` of `view` in the middle of the pane. */
function reveal(view: EditorView, line: number) {
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
}

/**
 * One conflicted file, opened as an editor tab.
 *
 * The two candidate versions sit side by side in a `MergeView`, because that is
 * the choice the reader is actually making. The base is the third document and
 * deliberately not a third pane: three columns of code do not fit the width
 * this pane gets, and what the base is *for* is the region under discussion, so
 * it is shown one region at a time under the header.
 *
 * Read-only in this phase. Accepting a side, marking resolved, and handing the
 * conflict to an agent are the next two phases; what this one owes them is the
 * region model and a way to walk it.
 */
export default function ConflictView(props: { workspace: string; file: string }) {
  const [stages, setStages] = createSignal<ConflictStages | null>(null);
  const [op, setOp] = createSignal<ConflictOp>("none");
  const [error, setError] = createSignal("");
  const [currentId, setCurrentId] = createSignal<string | null>(null);

  // Which read is current. The pane reuses one view across tabs of the same
  // kind, so a slower answer for the file you left can land under the file you
  // opened. Same token as `CommitDetail` and `CommitLog`, and the same reason.
  let current = 0;

  const regions = createMemo(() => {
    const s = stages();
    if (!s || s.binary) return [];
    return conflictRegions(s.base ?? "", s.ours ?? "", s.theirs ?? "");
  });
  const conflicts = createMemo(() => conflictsOnly(regions()));
  const at = createMemo(() => conflicts().findIndex((r) => r.id === currentId()));
  const currentRegion = createMemo(() => conflicts().find((r) => r.id === currentId()) ?? null);

  /** The base lines this conflict is a disagreement about. Empty when the two
   *  sides both inserted at a point (nothing of the base is involved) and null
   *  when there is no base at all, which is an add/add conflict. */
  const baseLines = createMemo<string[] | null>(() => {
    const r = currentRegion();
    const base = stages()?.base;
    if (!r || base == null) return null;
    return base.split("\n").slice(r.base.from - 1, r.base.to - 1);
  });

  async function load(workspace: string, file: string) {
    const mine = ++current;
    setCurrentId(null);
    try {
      const [read, operation] = await Promise.all([
        invoke<ConflictStages>("git_conflict_stages", { projectPath: workspace, file }),
        // The stages are the view; the operation only names the sides, so a
        // repo that cannot answer it still gets a usable conflict.
        invoke<ConflictOp>("git_conflict_op", { projectPath: workspace }).catch(
          () => "none" as ConflictOp,
        ),
      ]);
      if (mine !== current) return;
      // Together, so the panes are built once with both the documents and the
      // names that go on them.
      batch(() => {
        setStages(read);
        setOp(operation);
        setError("");
      });
    } catch (e) {
      if (mine !== current) return;
      batch(() => {
        setStages(null);
        setError(String(e));
      });
    }
  }

  createEffect(on([() => props.workspace, () => props.file], ([w, f]) => void load(w, f)));

  /**
   * Whether the shared store still lists this file as conflicted, or null when
   * it is describing some other workspace and so has nothing to say about it.
   */
  const listedConflicted = createMemo(() => {
    const s = gitState();
    if (s.root !== props.workspace) return null;
    return s.files.some((f) => f.conflicted && f.path === props.file);
  });

  // A conflict is not a commit: unlike the other tabs in this pane, what this
  // one shows can stop being true while it is open. Resolve the file in the
  // terminal, or abort the merge, and the stages are gone. The store already
  // re-reads on every watcher burst, so following it costs one read on the
  // transition and keeps the tab from presenting a merge that was abandoned.
  createEffect(
    on(listedConflicted, (now, before) => {
      if (now === null || before == null || now === before) return;
      void load(props.workspace, props.file);
    }),
  );

  let host: HTMLDivElement | undefined;
  let merge: MergeView | null = null;

  function destroy() {
    merge?.destroy();
    merge = null;
  }
  onCleanup(destroy);

  // Rebuilt rather than reconfigured when the documents change: both panes are
  // read-only, so no cursor, selection or scroll position in them is worth
  // carrying into a different file's conflict.
  createEffect(
    // `op` is a dependency, not just a read: `on` runs its body untracked, and
    // the labels the panes carry come from it. Without it here, a rebase's
    // panes would keep whatever names the previous read left behind.
    on([regions, stages, op], ([rs, s]) => {
      destroy();
      if (!host || !s || s.binary) return;
      // One `Text` per side, built here and handed to both the decorations and
      // the editor: `EditorStateConfig.doc` takes a `Text`, so splitting the
      // string a second time would only make a second copy of the same lines.
      const ours = Text.of((s.ours ?? "").split("\n"));
      const theirs = Text.of((s.theirs ?? "").split("\n"));
      const names = sideLabels(op());
      merge = new MergeView({
        a: { doc: ours, extensions: paneExtensions(rs, "ours", ours, names.ours) },
        b: { doc: theirs, extensions: paneExtensions(rs, "theirs", theirs, names.theirs) },
        parent: host,
        gutter: true,
        highlightChanges: true,
      });
    }),
  );

  // Walking is a change of region, whether it came from a button or (later) an
  // action that resolved one. Scrolling lives here rather than in the handlers
  // so every route to a region lands the same way.
  createEffect(
    on(currentRegion, (r) => {
      if (!r || !merge) return;
      reveal(merge.a, r.ours.from);
      reveal(merge.b, r.theirs.from);
    }),
  );

  return (
    <div class={styles.conflictView}>
      <div class={styles.header}>
        <span class={styles.path} title={props.file}>
          {props.file}
        </span>
        <span class={styles.op}>{OP_WORD[op()]}</span>
        <Show when={conflicts().length}>
          <span class={styles.counter}>
            {at() < 0
              ? `${conflicts().length} conflict${conflicts().length === 1 ? "" : "s"}`
              : `Conflict ${at() + 1} of ${conflicts().length}`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={!prevConflict(regions(), currentId())}
            title="Previous conflict"
            onClick={() => setCurrentId(prevConflict(regions(), currentId())?.id ?? null)}
          >
            ↑
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!nextConflict(regions(), currentId())}
            title="Next conflict"
            onClick={() => setCurrentId(nextConflict(regions(), currentId())?.id ?? null)}
          >
            ↓
          </Button>
        </Show>
      </div>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
      <Show when={stages()?.binary}>
        <div class={styles.error}>
          This file is binary, so there are no lines to merge. Resolve it by choosing a whole version.
        </div>
      </Show>
      {/* The third document, a region at a time. Without it the panes show two
          answers with no question: "what was here before" is most of what tells
          you which of them is right. */}
      <Show when={currentRegion()}>
        <div class={styles.base}>
          <span class={styles.baseLabel}>Base</span>
          <Show
            when={baseLines()?.length}
            fallback={
              <span class={styles.baseEmpty}>
                {baseLines() ? "Nothing here before: both sides added." : "No common ancestor."}
              </span>
            }
          >
            <pre class={styles.baseText}>
              <For each={baseLines()!}>{(l) => <div>{l || " "}</div>}</For>
            </pre>
          </Show>
        </div>
      </Show>
      <div class={styles.panes} ref={host} />
    </div>
  );
}
