import { createSignal, createMemo, createEffect, on, onCleanup, batch, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { gitState, refreshStatus } from "../../utils/gitActions";
import { EditorView, lineNumbers, showPanel, Decoration, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, RangeSetBuilder, Text, type Extension } from "@codemirror/state";
import { MergeView } from "@codemirror/merge";
import {
  conflictRegions,
  conflictsOnly,
  deletedSides,
  nextConflict,
  prevConflict,
  resolvedText,
  sideLabels,
  unresolved,
  type Choice,
  type ConflictOp,
  type ConflictRegion,
  type ConflictStages,
  type Side,
} from "../../utils/conflict";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { folderActors } from "../../utils/folderActors";
import { revertGuard } from "../../utils/revertGuard";
import Button from "../../components/Button/Button";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
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
 *
 * Once a conflict is decided, the same lines say which way: the side that was
 * taken and the side that was dropped have to look different, or a walk back
 * through the file cannot tell an answered conflict from an unanswered one.
 */
export function regionDecorations(
  regions: ConflictRegion[],
  side: Side,
  doc: Text,
  choices: Record<string, Choice>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of regions) {
    const { from, to } = r[side];
    const choice = choices[r.id];
    const cls = !r.both
      ? styles.carriedLine
      : !choice
        ? styles.conflictLine
        : choice === "both" || choice === side
          ? styles.acceptedLine
          : styles.droppedLine;
    for (let n = from; n < to; n++) {
      // A range can name a line past the end when a side ends without a
      // trailing newline. The range is still right; there is simply no line
      // there to decorate.
      if (n < 1 || n > doc.lines) continue;
      builder.add(doc.line(n).from, doc.line(n).from, Decoration.line({ class: cls }));
    }
  }
  return builder.finish();
}

function paneExtensions(
  regions: ConflictRegion[],
  side: Side,
  doc: Text,
  label: string,
  deco: Compartment,
  choices: Record<string, Choice>,
): Extension {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // CodeMirror gives its content `role="textbox"`, and an ARIA input field
    // with no accessible name is a serious axe violation - two of them here, one
    // per side, which is the worst case: the whole point of this view is which
    // of the two you are reading. The visible side label already says, so it is
    // the name as well. Found by the axe run added with the tooltip sweep.
    EditorView.contentAttributes.of({ "aria-label": label }),
    paneTheme,
    // In a compartment because accepting a side repaints these lines and
    // nothing else: rebuilding the panes for it would throw away the scroll
    // position of the file you are working through. Both documents are
    // read-only, so there is still no change for the set to be mapped through.
    deco.of(EditorView.decorations.of(regionDecorations(regions, side, doc, choices))),
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
 * The choices are held here and written **once**, when the reader marks the
 * file resolved. Until then the working copy is exactly as git left it, so a
 * tab abandoned half way through leaves the merge untouched rather than a
 * partly-rewritten file that looks finished.
 */
export default function ConflictView(props: {
  workspace: string;
  file: string;
  /** The same channel a discard or a checkpoint revert reports on: resolving
   *  rewrites a file that may be open with unsaved edits, and that buffer has
   *  to be offered keep-mine / take-disk rather than writing the old text back
   *  over the resolution on its next save. */
  onResolved?: (outcome: { backstop_ts: null; restored: string[]; deleted: string[] }) => void;
}) {
  const [stages, setStages] = createSignal<ConflictStages | null>(null);
  const [op, setOp] = createSignal<ConflictOp>("none");
  const [error, setError] = createSignal("");
  const [currentId, setCurrentId] = createSignal<string | null>(null);
  const [choices, setChoices] = createSignal<Record<string, Choice>>({});
  /** For a conflict about the file's existence: whether to keep it or not. */
  const [keepFile, setKeepFile] = createSignal<boolean | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);

  const askConfirm = (opts: Omit<ConfirmReq, "resolve">): Promise<boolean> =>
    new Promise((resolve) => setConfirmReq({ ...opts, resolve }));

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
  const names = createMemo(() => sideLabels(op()));

  /** One side has no version of the file at all, so the decision is whether the
   *  file survives, not which lines it holds. Nothing to walk, and "accept
   *  theirs" would mean an empty file where git means no file. */
  const deleted = createMemo(() => (stages() ? deletedSides(stages()!) : []));
  /** The side that still has the file, when the other one deleted it. */
  const survivor = createMemo<Side | null>(() => {
    const gone = deleted();
    if (!gone.length || gone.length === 2) return null;
    return gone[0] === "ours" ? "theirs" : "ours";
  });
  const left = createMemo(() => unresolved(regions(), choices()));

  /** The file the choices add up to, or null while anything is undecided.
   *  `undefined` is the deletion case, which has no text to build. */
  const resolution = createMemo<string | null | undefined>(() => {
    const s = stages();
    if (!s || s.binary) return null;
    if (deleted().length) {
      if (keepFile() === null) return null;
      if (!keepFile()) return undefined;
      const side = survivor();
      return side ? (s[side] ?? "") : null;
    }
    return resolvedText(s, regions(), choices());
  });
  const canResolve = () => !saving() && resolution() !== null;

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
    // The choices describe the stages that are being replaced, so they cannot
    // outlive a read: a different file's ids would not match, and the same
    // file's would match the wrong lines.
    batch(() => {
      setChoices({});
      setKeepFile(null);
      setDone(false);
    });
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

  // The tab opens on the first conflict rather than on nothing. Everything that
  // acts on a conflict acts on the one being looked at, so with nothing
  // selected the only control on screen is navigation, and the reader has to
  // discover that pressing it is what reveals the rest.
  createEffect(
    on(conflicts, (list) => {
      if (!list.length) return;
      const id = currentId();
      if (id && list.some((r) => r.id === id)) return;
      setCurrentId(list[0].id);
    }),
  );

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
      // Except when this tab is what resolved it: re-reading then would ask the
      // backend for stages we just removed and answer with its refusal, which
      // reads as a failure rather than as the success it followed.
      if (done() && !now) return;
      void load(props.workspace, props.file);
    }),
  );

  /**
   * Write the resolution and mark the file merged.
   *
   * One write, at the end, rather than one per accepted region: until this runs
   * the working copy is what git left, so closing the tab half way through
   * changes nothing. Afterwards the file is staged, which is what takes it out
   * of the Conflicts section.
   */
  async function markResolved() {
    const text = resolution();
    if (text === null || saving()) return;
    // Held across the confirms, not just the write: the dialog is a singleton,
    // so a second click behind it replaces the pending question and the answer
    // lands on something else. Same reason the panel's `busy` exists.
    setSaving(true);
    try {
      // A resolution rewrites a whole file, and can remove one, which is the
      // blast radius the guard is about: an agent mid-turn in this folder may
      // be writing the very file being replaced. Whole-file discard and every
      // stash action ask the same question.
      const candidates = await folderActors(props.workspace);
      const verdict = revertGuard(candidates, { folderPath: props.workspace });
      if (!verdict.allow) {
        if (!verdict.overridable) {
          emitWith<ToastEvent>(TOAST, { message: verdict.reason, kind: "error" });
          return;
        }
        const go = await askConfirm({
          title: "Another session may be running here",
          message: `${verdict.reason}\n\nResolve anyway?`,
          confirmLabel: "Resolve anyway",
          danger: true,
        });
        if (!go) return;
        if (!revertGuard(candidates, { folderPath: props.workspace, allowDetached: true }).allow) {
          return;
        }
      }
      // The one resolution with something to lose: `git rm` takes the file out
      // of the worktree, and while the merge is unfinished the way back is a
      // command, not a click.
      if (text === undefined) {
        const go = await askConfirm({
          title: `Delete ${props.file}?`,
          message: `Resolving this conflict the way ${names()[deleted()[0]]} did removes the file from the worktree and stages the deletion. While the ${OP_WORD[op()].toLowerCase()} is unfinished you can bring it back with \`git checkout -m -- ${props.file}\`.`,
          confirmLabel: "Delete file",
          danger: true,
        });
        if (!go) return;
      }
      await invoke("git_conflict_resolve", {
        projectPath: props.workspace,
        file: props.file,
        content: text ?? null,
      });
      // Before the status refresh, so the buffer question is asked against the
      // file that was just written rather than racing the store's re-read.
      props.onResolved?.({
        backstop_ts: null,
        restored: text === undefined ? [] : [props.file],
        deleted: text === undefined ? [props.file] : [],
      });
      setDone(true);
      await refreshStatus(props.workspace);
    } catch (e) {
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  let host: HTMLDivElement | undefined;
  let merge: MergeView | null = null;
  // One per pane rather than one shared: a compartment is a position in a
  // configuration, and these are two configurations.
  const decoOurs = new Compartment();
  const decoTheirs = new Compartment();

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
      // Read untracked on purpose, which is the opposite of what `op` needs
      // here: a rebuild is for a different set of documents, and accepting a
      // side is not that. The effect below repaints instead.
      const picked = choices();
      merge = new MergeView({
        a: {
          doc: ours,
          extensions: paneExtensions(rs, "ours", ours, names().ours, decoOurs, picked),
        },
        b: {
          doc: theirs,
          extensions: paneExtensions(rs, "theirs", theirs, names().theirs, decoTheirs, picked),
        },
        parent: host,
        gutter: true,
        highlightChanges: true,
      });
    }),
  );

  // Accepting a side repaints its lines and nothing else, so it reconfigures
  // rather than rebuilds: the panes keep the scroll position of the file the
  // reader is working through.
  createEffect(
    on(choices, (picked) => {
      if (!merge) return;
      const rs = regions();
      for (const [view, side, deco] of [
        [merge.a, "ours", decoOurs],
        [merge.b, "theirs", decoTheirs],
      ] as const) {
        view.dispatch({
          effects: deco.reconfigure(
            EditorView.decorations.of(regionDecorations(rs, side, view.state.doc, picked)),
          ),
        });
      }
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
        <div class={styles.actions}>
          <Show when={!deleted().length && conflicts().length}>
            <span class={styles.counter}>
              {at() < 0
                ? `${conflicts().length} conflict${conflicts().length === 1 ? "" : "s"}`
                : `Conflict ${at() + 1} of ${conflicts().length}`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!prevConflict(regions(), currentId())}
              // The visible text is "↑", so the name has to be written out:
              // this is not the tooltip being duplicated, it is the name the
              // button never had.
              aria-label="Previous conflict"
              tooltip="Previous conflict"
              onClick={() => setCurrentId(prevConflict(regions(), currentId())?.id ?? null)}
            >
              ↑
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!nextConflict(regions(), currentId())}
              aria-label="Next conflict"
              tooltip="Next conflict"
              onClick={() => setCurrentId(nextConflict(regions(), currentId())?.id ?? null)}
            >
              ↓
            </Button>
          </Show>
          <Show when={stages() && !stages()!.binary && !done()}>
            <Button
              size="xs"
              variant="primary"
              disabled={!canResolve()}
              // The one control here whose label answers "why can't I press
              // this?", so it is the one that has to stay reachable while
              // disabled - a disabled button fires no pointer events of its own.
              tooltipWhenDisabled
              tooltip={
                canResolve()
                  ? "Write the resolution and stage it as merged"
                  : deleted().length
                    ? "Say whether the file survives first"
                    : `${left().length} conflict${left().length === 1 ? "" : "s"} still undecided`
              }
              onClick={() => void markResolved()}
            >
              {resolution() === undefined ? "Delete and mark resolved" : "Mark resolved"}
            </Button>
          </Show>
        </div>
      </div>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
      <Show when={done()}>
        <div class={styles.resolved} role="status">
          Resolved. {props.file} is staged as merged.
        </div>
      </Show>
      <Show when={stages()?.binary}>
        <div class={styles.error}>
          This file is binary, so there are no lines to merge. It has to be resolved in the terminal,
          by choosing a whole version.
        </div>
      </Show>
      {/* A conflict about whether the file exists at all. No lines to choose
          between, so no walk and no per-region buttons: one side deleted it and
          the other did not, and that is the whole question. */}
      <Show when={deleted().length && !stages()?.binary && !done()}>
        <div class={styles.choices}>
          <span class={styles.choiceLabel}>
            {deleted().length === 2
              ? "Both sides deleted this file."
              : `${names()[deleted()[0]]} deleted this file; ${names()[survivor()!]} changed it.`}
          </span>
          <Show when={survivor()}>
            <Button
              size="xs"
              variant={keepFile() === true ? "primary" : "default"}
              aria-pressed={keepFile() === true}
              tooltip="Keep the file, with the surviving side's contents"
              onClick={() => setKeepFile(true)}
            >
              Keep {names()[survivor()!]}
            </Button>
          </Show>
          <Button
            size="xs"
            variant={keepFile() === false ? "primary" : "default"}
            aria-pressed={keepFile() === false}
            tooltip="Accept the deletion"
            onClick={() => setKeepFile(false)}
          >
            Delete the file
          </Button>
        </div>
      </Show>
      {/* The decision itself, for the conflict being looked at. The two side
          buttons are named by the operation, not by stage: under a rebase the
          version git calls "ours" is the upstream's, and a button that says
          yours over somebody else's work is wrong in the most convincing way. */}
      <Show when={!done() && currentRegion()}>
        {(r) => (
          <div class={styles.choices}>
            <span class={styles.choiceLabel}>Take</span>
            <For each={["ours", "theirs", "both"] as const}>
              {(c) => (
                <Button
                  size="xs"
                  variant={choices()[r().id] === c ? "primary" : "default"}
                  aria-pressed={choices()[r().id] === c}
                  // Contains the visible text rather than replacing it ("Take
                  // Upstream" over "Upstream"), which is what keeps the name
                  // and the label agreeing.
                  aria-label={c === "both" ? "Keep both versions, ours first" : `Take ${names()[c]}`}
                  tooltip={c === "both" ? "Keep both versions, ours first" : `Take ${names()[c]}`}
                  onClick={() => setChoices({ ...choices(), [r().id]: c })}
                >
                  {c === "both" ? "Both" : names()[c]}
                </Button>
              )}
            </For>
          </div>
        )}
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
      <Show when={confirmReq()}>
        <ConfirmDialog
          title={confirmReq()!.title}
          message={confirmReq()!.message}
          confirmLabel={confirmReq()!.confirmLabel}
          danger={confirmReq()!.danger}
          onConfirm={() => {
            confirmReq()!.resolve(true);
            setConfirmReq(null);
          }}
          onCancel={() => {
            confirmReq()!.resolve(false);
            setConfirmReq(null);
          }}
        />
      </Show>
    </div>
  );
}
