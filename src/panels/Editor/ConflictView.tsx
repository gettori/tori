import { createSignal, createMemo, createEffect, on, onCleanup, batch, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { gitStateFor, refreshStatus } from "../../utils/gitActions";
import { EditorView, lineNumbers, showPanel, Decoration, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, RangeSetBuilder, Text, type Extension } from "@codemirror/state";
import { MergeView } from "@codemirror/merge";
import {
  bothChoices,
  choiceLines,
  conflictRegions,
  conflictsOnly,
  deletedSides,
  keeps,
  nextConflict,
  prevConflict,
  seedResult,
  sideLabels,
  unresolved,
  type Choice,
  type ConflictOp,
  type ConflictRegion,
  type ConflictStages,
  type Side,
  type SideLabels,
} from "../../utils/conflict";
import { choiceOptions, decideRegion, resetResult, resultField } from "./resultPane";
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

// The base is not one of the two candidates, so it is never a side to take.
type PaneSide = Side | "base";

// Ours against theirs is the decision itself; either against the base answers
// "what did this side change", which is the question a conflict between two
// rewrites usually turns on.
const PAIRS: { id: string; left: PaneSide; right: PaneSide }[] = [
  { id: "sides", left: "ours", right: "theirs" },
  { id: "base-ours", left: "base", right: "ours" },
  { id: "base-theirs", left: "base", right: "theirs" },
];

// Its own theme rather than CodeEditor's: that module is the lazy edge of the
// whole editing stack (LSP, vim, the prefs), and these panes need none of it.
// The language and its colours arrive on their own, through `syntaxFor`.
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
  side: PaneSide,
  doc: Text,
  choices: Record<string, Choice>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of regions) {
    const { from, to } = r[side];
    const choice = choices[r.id];
    const cls = !r.both
      ? styles.carriedLine
      : // The base was not a candidate, so nothing here was taken or dropped:
        // these are the lines the two sides disagree about, and that is all.
        side === "base"
        ? styles.conflictLine
        : !choice
          ? styles.conflictLine
          : keeps(choice, side)
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
  side: PaneSide,
  doc: Text,
  label: string,
  deco: Compartment,
  choices: Record<string, Choice>,
  syntax: Compartment,
  syntaxExt: Extension,
): Extension {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // In a compartment of its own because the language pack is fetched after
    // the pane is already on screen: whichever of the two lands first, the
    // other reaches it without rebuilding and losing the reader's place.
    syntax.of(syntaxExt),
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

const sideName = (side: PaneSide, names: SideLabels) => (side === "base" ? "Base" : names[side]);

const pairName = (p: (typeof PAIRS)[number], names: SideLabels) =>
  `Compare ${sideName(p.left, names)} with ${sideName(p.right, names)}`;

/** Put line `line` of `view` in the middle of the pane. */
function reveal(view: EditorView, line: number) {
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
}

/**
 * One conflicted file, opened as an editor tab.
 *
 * Two of the three documents sit side by side in a `MergeView`, because a diff
 * takes two; which two is the reader's to pick, since "what did this side
 * change" is a different question from "which of these do I want". Three
 * columns of code would not fit the width this pane gets, so the base also
 * stays available a region at a time under the header.
 *
 * Under them is the Result pane, which is the answer and is editable: a merge
 * often needs a line neither side wrote, and the alternative is resolving it
 * wrong on purpose and then opening the file to fix it.
 *
 * It is written **once**, when the reader marks the file resolved. Until then
 * the working copy is exactly as git left it, so a tab abandoned half way
 * through leaves the merge untouched rather than a partly-rewritten file that
 * looks finished.
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
  const [pairId, setPairId] = createSignal(PAIRS[0].id);
  /** The language and its colours, once fetched. Null until then, and for a
   *  file whose suffix names no language. */
  const [syntax, setSyntax] = createSignal<Extension | null>(null);

  const pair = () => PAIRS.find((p) => p.id === pairId()) ?? PAIRS[0];

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

  /** What the file's existence was decided to be, when that is the question:
   *  the surviving text to keep, `undefined` to remove the file, null while it
   *  is unanswered. Null too when the question is about lines instead, which
   *  the Result pane answers rather than this. */
  const deletion = createMemo<string | null | undefined>(() => {
    const s = stages();
    if (!s || s.binary || !deleted().length) return null;
    if (keepFile() === null) return null;
    if (!keepFile()) return undefined;
    const side = survivor();
    return side ? (s[side] ?? "") : null;
  });
  const removesFile = () => deleted().length > 0 && keepFile() === false;

  const canResolve = () => {
    if (saving()) return false;
    const s = stages();
    if (!s || s.binary) return false;
    // The text itself is no longer derived here, so the gate is only whether
    // every conflict has an answer; what those answers add up to is whatever
    // the Result pane holds, hand edits included.
    return deleted().length ? deletion() !== null : left().length === 0;
  };

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
   * this workspace has no slot in it and so has nothing to say about it.
   */
  const listedConflicted = createMemo(() => {
    const s = gitStateFor(props.workspace);
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
    if (!canResolve()) return;
    // `undefined` means remove the file, so a missing pane must not fall
    // through to it: the two are one keystroke apart and only one is reversible.
    let text: string | null | undefined;
    if (deleted().length) text = deletion();
    else if (result) text = result.state.doc.toString();
    else return;
    if (text === null) return;
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
  let resultHost: HTMLDivElement | undefined;
  let merge: MergeView | null = null;
  let result: EditorView | null = null;
  // One per pane rather than one shared: a compartment is a position in a
  // configuration, and these are three configurations.
  const decoLeft = new Compartment();
  const decoRight = new Compartment();
  const syntaxLeft = new Compartment();
  const syntaxRight = new Compartment();
  const syntaxResult = new Compartment();

  // Per conflict, because whether the two sides' edits splice is a character
  // diff, and the Result pane asks again on every keystroke.
  const bothFor = createMemo(() => {
    const s = stages();
    return new Map(conflictsOnly(regions()).map((r) => [r.id, s ? bothChoices(s, r) : (["both"] as Choice[])]));
  });
  const optionsFor = (id: string) => choiceOptions(names(), bothFor().get(id) ?? ["both"]);
  const slots = resultField(optionsFor, chooseRegion);

  function destroy() {
    merge?.destroy();
    merge = null;
  }
  function destroyResult() {
    result?.destroy();
    result = null;
  }
  onCleanup(() => {
    destroy();
    destroyResult();
  });

  // Newline-terminated, because a slot's span reaches past its own newline:
  // that is what lets taking a side that deletes the lines remove the line
  // rather than leave a blank one behind.
  function textFor(r: ConflictRegion, choice: Choice): string | null {
    const s = stages();
    if (!s) return null;
    const lines = choiceLines(s, r, choice);
    // `hand` leaves the slot's blank line alone: that line is where the reader
    // is about to type, so replacing it would take the cursor's home away.
    if (!lines) return null;
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  // Both routes to a decision land here, so the header and the slot cannot
  // disagree about what was chosen or about what the document says.
  function chooseRegion(id: string, choice: Choice) {
    setChoices({ ...choices(), [id]: choice });
    const r = regions().find((x) => x.id === id);
    const slot = result?.state.field(slots, false)?.slots.find((s) => s.id === id);
    if (!result || !r || !slot) return;
    const put = textFor(r, choice);
    result.dispatch({
      changes: put === null ? undefined : { from: slot.from, to: slot.to, insert: put },
      effects: decideRegion.of({ id, choice }),
    });
  }

  // Rebuilt rather than reconfigured when the documents change: both panes are
  // read-only, so no cursor, selection or scroll position in them is worth
  // carrying into a different file's conflict. `pair` rebuilds them too, since
  // a different pair is a different pair of documents.
  createEffect(
    // `op` is a dependency, not just a read: `on` runs its body untracked, and
    // the labels the panes carry come from it. Without it here, a rebase's
    // panes would keep whatever names the previous read left behind.
    on([regions, stages, op, pair], ([rs, s, , showing]) => {
      destroy();
      if (!host || !s || s.binary) return;
      // One `Text` per side, built here and handed to both the decorations and
      // the editor: `EditorStateConfig.doc` takes a `Text`, so splitting the
      // string a second time would only make a second copy of the same lines.
      const docFor = (side: PaneSide) => Text.of((s[side] ?? "").split("\n"));
      // Read untracked on purpose, which is the opposite of what `op` needs
      // here: a rebuild is for a different set of documents, and accepting a
      // side is not that. The effect below repaints instead.
      const picked = choices();
      const ext = syntax() ?? [];
      const leftDoc = docFor(showing.left);
      const rightDoc = docFor(showing.right);
      merge = new MergeView({
        a: {
          doc: leftDoc,
          extensions: paneExtensions(rs, showing.left, leftDoc, sideName(showing.left, names()), decoLeft, picked, syntaxLeft, ext),
        },
        b: {
          doc: rightDoc,
          extensions: paneExtensions(rs, showing.right, rightDoc, sideName(showing.right, names()), decoRight, picked, syntaxRight, ext),
        },
        parent: host,
        gutter: true,
        highlightChanges: true,
      });
    }),
  );

  // The Result pane is deliberately not rebuilt for a pair switch: it holds the
  // reader's own edits, and the pair is a question about the two candidates.
  createEffect(
    on([regions, stages, op], ([rs, s]) => {
      destroyResult();
      if (!resultHost || !s || s.binary || deletedSides(s).length) return;
      const seed = seedResult(s, rs);
      result = new EditorView({
        doc: seed.text,
        extensions: [
          lineNumbers(),
          // A third `role="textbox"` on screen, and the only editable one, so
          // it needs the name the other two got for the same reason.
          EditorView.contentAttributes.of({ "aria-label": "Result" }),
          paneTheme,
          syntaxResult.of(syntax() ?? []),
          slots,
          showPanel.of(() => {
            const dom = document.createElement("div");
            dom.className = styles.sideLabel;
            dom.textContent = "Result";
            return { dom, top: true };
          }),
        ],
        parent: resultHost,
      });
      result.dispatch({ effects: resetResult.of({ slots: seed.slots, choices: {} }) });
    }),
  );

  // The language pack is fetched per file and lands after the panes are up, so
  // every view reaches it through a compartment rather than being rebuilt.
  createEffect(
    on(() => props.file, (file) => {
      setSyntax(null);
      void import("./syntaxStyle").then(
        async (m) => {
          const ext = await m.syntaxFor(file);
          if (props.file === file) setSyntax(() => ext);
        },
        // A failed chunk load leaves the panes uncoloured, which is what they
        // looked like before; nothing retries because nothing would change.
        () => {},
      );
    }),
  );

  createEffect(
    on(syntax, (ext) => {
      const applied = ext ?? [];
      if (merge) {
        merge.a.dispatch({ effects: syntaxLeft.reconfigure(applied) });
        merge.b.dispatch({ effects: syntaxRight.reconfigure(applied) });
      }
      result?.dispatch({ effects: syntaxResult.reconfigure(applied) });
    }),
  );

  // Accepting a side repaints its lines and nothing else, so it reconfigures
  // rather than rebuilds: the panes keep the scroll position of the file the
  // reader is working through.
  createEffect(
    on(choices, (picked) => {
      if (!merge) return;
      const rs = regions();
      // Which document a pane holds is the pair's answer, not a fixed one: with
      // the base on the left, painting it as "ours" would colour the wrong
      // lines and call a region accepted that nobody accepted.
      for (const [view, side, deco] of [
        [merge.a, pair().left, decoLeft],
        [merge.b, pair().right, decoRight],
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
      reveal(merge.a, r[pair().left].from);
      reveal(merge.b, r[pair().right].from);
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
          {/* Against the base it is what one side did, which is the only way to
              read a conflict where both sides rewrote the same block. */}
          <Show when={stages() && !stages()!.binary && !deleted().length}>
            <div class={styles.pairs} role="group" aria-label="Compare">
              <For each={PAIRS}>
                {(p) => (
                  <Button
                    size="xs"
                    variant={pairId() === p.id ? "primary" : "default"}
                    aria-pressed={pairId() === p.id}
                    aria-label={pairName(p, names())}
                    tooltip={pairName(p, names())}
                    onClick={() => setPairId(p.id)}
                  >
                    {sideName(p.left, names())} / {sideName(p.right, names())}
                  </Button>
                )}
              </For>
            </div>
          </Show>
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
              {removesFile() ? "Delete and mark resolved" : "Mark resolved"}
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
            <For each={optionsFor(r().id)}>
              {(c) => (
                <Button
                  size="xs"
                  variant={choices()[r().id] === c.choice ? "primary" : "default"}
                  aria-pressed={choices()[r().id] === c.choice}
                  // Contains the visible text rather than replacing it ("Take
                  // Upstream" over "Upstream"), which is what keeps the name
                  // and the label agreeing.
                  aria-label={c.name}
                  tooltip={c.name}
                  onClick={() => chooseRegion(r().id, c.choice)}
                >
                  {c.text}
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
      {/* The answer, as a document rather than as a sum of button presses. A
          merge often needs a line neither side wrote, and every other route to
          one is "resolve it wrong, then open the file and fix it". */}
      <Show when={stages() && !stages()!.binary && !deleted().length}>
        <div class={styles.result} ref={resultHost} />
      </Show>
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
