import { batch, createSignal, createMemo, createEffect, lazy, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  FileCode,
  Minus,
  Pilcrow,
  Plus,
  RefreshCw,
  SquareCode,
  Undo2,
  UserRound,
} from "lucide-solid";
import {
  emitWith,
  onWith,
  AGENT_FILES_WRITTEN,
  AGENT_WRITE_DEBOUNCE_MS,
  OPEN_IN_EDITOR,
  TOAST,
  type AgentFilesWritten,
  type FsChanged,
  type ToastEvent,
} from "../../utils/events";
import { debounce } from "../../utils/debounce";
import { blameFor, dropBlame, type Blame } from "../../utils/blame";
import { blameOn, writeBlamePref } from "../../utils/blamePref";
import {
  gitStateFor,
  refreshStatus,
  stage as stageFiles,
  unstage as unstageFiles,
} from "../../utils/gitActions";
import { parseDiffHunks, DIFF_CONTEXT } from "../../utils/diffHunks";
import { buildRows, hunkGaps, type Gap } from "../../utils/diffView";
import { hunkFingerprint } from "../../utils/hunkFingerprint";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../utils/sideBySide";
import { diffEditorLayoutOn as editorLayout, writeDiffEditorLayout } from "../../utils/diffLayout";
import { diffIgnoreWhitespaceOn as ignoreWhitespace, writeDiffIgnoreWhitespace } from "../../utils/diffWhitespace";
import { copyText } from "../../utils/clipboard";
import { sendTargetFor } from "../../utils/sendTarget";
import { parseDiffArg } from "../../utils/syntheticTabs";
import type { TintedMember } from "../../utils/featureMembers";
import Breadcrumbs from "./Breadcrumbs";
import DiffRows, { diffRowClasses } from "./DiffRows";
import HunkCommentInput from "./HunkCommentInput";
import type { RevertOutcome } from "./CheckpointTimeline";
import ConfirmDialog, { type ConfirmReq } from "../../components/Dialogs/ConfirmDialog";
import IconButton from "../../components/IconButton/IconButton";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import crumbStyles from "./Breadcrumbs.module.css";
import hunkStyles from "./HunkCommentInput.module.css";
import styles from "./DiffView.module.css";

const DiffBufferView = lazy(() => import("./DiffBufferView"));

/** What `git_discard_hunks` reports back: the backstop that makes the discard
 *  undoable, plus the paths that changed on disk. */
type DiscardOutcome = {
  backstop_ts: number;
  restored: string[];
  deleted: string[];
};

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// Map a porcelain XY code to a coarse class for the badge color.
function statusClass(status: string): string {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

/**
 * One file's diff, as an editor tab.
 *
 * The hunk controls live here rather than in the Changes panel because staging
 * wants room: the panel's rows stay one line tall and scannable, and the patch
 * it used to unfold inline gets the width of a pane instead.
 *
 * Staged and unstaged are separate tabs, not a toggle inside one. A partially
 * staged file's two diffs are different documents (index-vs-HEAD and
 * worktree-vs-index), every fingerprint is derived against one of them, and the
 * tab id has to name which or two rows would collide on one key.
 */
export default function DiffView(props: {
  workspace: string;
  /** The tab's arg: the comparison and the repo-relative path. */
  arg: string;
  selected: Selection | null;
  /** The member holding the file inside a Feature, for the breadcrumb trail. */
  member?: TintedMember | null;
  onReverted?: (outcome: RevertOutcome) => void;
}) {
  const parsed = createMemo(() => parseDiffArg(props.arg));
  const file = () => parsed().file;
  const staged = () => parsed().staged;

  const [diff, setDiff] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [applying, setApplying] = createSignal(false);
  const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
  const [paneWidth, setPaneWidth] = createSignal(Infinity);
  // Which collapsed regions the user opened, keyed by the hunk they follow.
  const [openGaps, setOpenGaps] = createSignal<ReadonlySet<string>>(new Set());
  const [gapLines, setGapLines] = createSignal<Record<string, string[]>>({});
  // The lines picked for a line-level stage, and the hunk they came from. One
  // hunk at a time: the patch is rebuilt from a single hunk's body, so a
  // selection spanning two could not be applied as one request anyway.
  const [picked, setPicked] = createSignal<{ hunk: number; lines: ReadonlySet<number> } | null>(null);
  const [fileText, setFileText] = createSignal<string | null>(null);
  const [blame, setBlame] = createSignal<Blame | null>(null);
  const [caret, setCaret] = createSignal<{ line: number; column: number } | null>(null);
  let nav: { next: () => void; previous: () => void } | undefined;

  const hunks = createMemo(() => parseDiffHunks(diff()));
  const gaps = createMemo(() => hunkGaps(hunks()));

  /** This file's porcelain row, so the badge and the actions answer from the
   *  shared store rather than from a second status read. */
  const entry = () => gitStateFor(props.workspace).files.find((f) => f.path === file());

  const gate = () => sendTargetFor(props.selected ?? null);
  const target = () => {
    const g = gate();
    return "target" in g ? g.target : null;
  };
  const disabledReason = () => {
    const g = gate();
    return "reason" in g ? g.reason : null;
  };

  // A line selection is indices into one hunk's body, so it means nothing once
  // the hunks move.
  createEffect(on(diff, () => setPicked(null)));

  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  // Staging re-derives the diff without -w, so a hunk read with it matches
  // nothing git would apply.
  const canStage = () => !ignoreWhitespace();
  const linesLabel = (count: number) => `${staged() ? "Unstage" : "Stage"} ${count} line${count === 1 ? "" : "s"}`;

  function toastError(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  async function fetchDiff(): Promise<string> {
    try {
      return await invoke<string>("git_diff_text", {
        projectPath: props.workspace,
        file: file(),
        context: DIFF_CONTEXT,
        mode: staged() ? "staged" : "unstaged",
        ignoreWhitespace: ignoreWhitespace(),
      });
    } catch (e) {
      toastError(e);
      return "";
    }
  }

  async function fetchText(): Promise<string | null> {
    try {
      const lines = await invoke<string[]>("git_file_slice", {
        projectPath: props.workspace,
        file: file(),
        mode: staged() ? "staged" : "unstaged",
        start: 1,
        end: Number.MAX_SAFE_INTEGER,
      });
      return lines.join("\n");
    } catch (e) {
      // A file deleted from the working tree has no text to read, and its
      // hunks still draw, as removed lines over an empty buffer.
      if (entry()?.status.includes("D")) return "";
      toastError(e);
      return null;
    }
  }

  async function fetchBlame(): Promise<Blame | null> {
    const head = gitStateFor(props.workspace).head;
    // git blames the working tree, which is not the text the staged tab shows.
    if (!blameOn() || staged() || !head) return null;
    return blameFor(props.workspace, file(), head);
  }

  /** Re-read the diff and drop what was derived from the old one. Called after
   *  every apply and whenever the file changes on disk, so the rendered hunks
   *  (and the fingerprints taken from them) never lag the file. */
  async function reload() {
    const [text, body, blamed] = await Promise.all([
      fetchDiff(),
      editorLayout() ? fetchText() : null,
      editorLayout() ? fetchBlame() : null,
    ]);
    batch(() => {
      setDiff(text);
      setFileText(body);
      setBlame(blamed);
      // The hunks just moved, so the cached gap contents no longer line up with
      // the ranges they were fetched for.
      setOpenGaps(new Set<string>());
      setGapLines({});
    });
  }

  createEffect(
    on([() => props.workspace, () => props.arg], async () => {
      setLoading(true);
      await reload();
      setLoading(false);
    }),
  );

  // Picks belong to the layout they were made in, the text is only fetched by a
  // reload, and another diff tab can flip the layout.
  createEffect(
    on(
      editorLayout,
      () => {
        setPicked(null);
        void reload();
      },
      { defer: true },
    ),
  );

  createEffect(on(ignoreWhitespace, () => void reload(), { defer: true }));
  createEffect(
    on(
      [blameOn, () => gitStateFor(props.workspace).head],
      async () => {
        if (editorLayout()) setBlame(await fetchBlame());
      },
      { defer: true },
    ),
  );

  /** Run one index-shuffling apply and put the view back in step with it. On
   *  failure the refetch happens before the error surfaces, so the user is
   *  never left looking at hunks that have already moved. */
  async function applied(run: () => Promise<unknown>) {
    if (applying()) return;
    setApplying(true);
    try {
      await run();
      await Promise.all([refreshStatus(props.workspace), reload()]);
    } catch (e) {
      await reload();
      toastError(e);
    } finally {
      setApplying(false);
    }
  }

  function askConfirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
    return new Promise((resolve) => setConfirmReq({ ...opts, resolve }));
  }

  // Fetch (once) and reveal the file lines behind a collapsed gap. Clicking an
  // open gap closes it again; the fetched lines stay cached so reopening is
  // instant.
  async function expandGap(key: string, gap: Gap) {
    if (openGaps().has(key)) {
      setOpenGaps((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    if (!gapLines()[key]) {
      try {
        const lines = await invoke<string[]>("git_file_slice", {
          projectPath: props.workspace,
          file: file(),
          mode: staged() ? "staged" : "unstaged",
          start: gap.start,
          end: gap.end,
        });
        // Rendered as context lines, so they carry the leading space a diff
        // context line would have.
        setGapLines((prev) => ({ ...prev, [key]: lines.map((l) => ` ${l}`) }));
      } catch (e) {
        toastError(e);
        return;
      }
    }
    setOpenGaps((prev) => new Set(prev).add(key));
  }

  /** Toggle one body line of one hunk into the selection. Emptying a selection
   *  drops it, so the "N lines" control disappears with the last line rather
   *  than lingering as a disabled button. */
  function pickLine(hunk: number, line: number) {
    setPicked((prev) => {
      const lines = new Set(prev?.hunk === hunk ? prev.lines : []);
      if (!lines.delete(line)) lines.add(line);
      return lines.size ? { hunk, lines } : null;
    });
  }

  function applyHunk(index: number, fingerprint: string) {
    return applied(() =>
      invoke("git_apply_hunks", {
        projectPath: props.workspace,
        file: file(),
        hunkIndices: [index],
        fingerprints: [fingerprint],
        reverse: staged(),
        context: DIFF_CONTEXT,
      }),
    );
  }

  function applyLines(index: number, fingerprint: string, lines: number[]) {
    return applied(() =>
      invoke("git_apply_lines", {
        projectPath: props.workspace,
        file: file(),
        hunkIndex: index,
        fingerprint,
        lines,
        reverse: staged(),
        context: DIFF_CONTEXT,
      }),
    );
  }

  /** Throw away one unstaged hunk.
   *
   *  No `revertGuard` here on purpose: the blast radius is one hunk of one file
   *  the user is looking at, and blocking that on any session being busy
   *  anywhere in the folder would make the control unusable exactly when it is
   *  most wanted. Whole-file discard, which is unscoped, does consult it. */
  async function discardHunk(index: number, fingerprint: string) {
    if (applying()) return;
    const ok = await askConfirm({
      title: "Discard this hunk?",
      message: `This change to ${file()} goes away. It is not staged, so git has no other copy of it.\n\nTori saves a snapshot first, so you can bring it back from Undo history in the timeline.`,
      confirmLabel: "Discard hunk",
      danger: true,
    });
    if (!ok) return;
    setApplying(true);
    try {
      const outcome = await invoke<DiscardOutcome>("git_discard_hunks", {
        projectPath: props.workspace,
        file: file(),
        hunkIndices: [index],
        fingerprints: [fingerprint],
        context: DIFF_CONTEXT,
      });
      props.onReverted?.({
        backstop_ts: outcome.backstop_ts,
        restored: outcome.restored,
        deleted: outcome.deleted,
      });
      await Promise.all([refreshStatus(props.workspace), reload()]);
    } catch (e) {
      await reload();
      toastError(e);
    } finally {
      setApplying(false);
    }
  }

  async function copyDiff() {
    const text = diff() || (await fetchDiff());
    if (!text) {
      emitWith<ToastEvent>(TOAST, { message: "No diff to copy.", kind: "error" });
      return;
    }
    const ok = await copyText(text);
    emitWith<ToastEvent>(TOAST, {
      message: ok ? `Copied diff for ${file()}` : "Couldn't copy to the clipboard.",
      kind: ok ? "info" : "error",
    });
  }

  let paneRef: HTMLDivElement | undefined;
  let unlistenFs: UnlistenFn | undefined;
  let offAgentWrites: (() => void) | undefined;
  const agentWritten = new Set<string>();
  const flushAgentWrites = debounce(() => {
    const paths = [...agentWritten];
    agentWritten.clear();
    if (paths.some((p) => p.endsWith(file()))) fileWritten();
  }, AGENT_WRITE_DEBOUNCE_MS);

  // A write changes which lines are uncommitted, and the blame cache is keyed
  // by HEAD, which a write does not move.
  function fileWritten() {
    dropBlame(props.workspace, file());
    void reload();
  }

  onMount(async () => {
    if (paneRef) {
      const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
      ro.observe(paneRef);
      onCleanup(() => ro.disconnect());
    }
    // An agent writing this file renumbers its hunks, so a stale view would
    // carry a fingerprint the backend refuses. `file()` is porcelain's field
    // rather than necessarily a path, so this is a suffix test against the
    // watcher's absolute paths.
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      const from = e.payload.root;
      if (from && from !== props.workspace) return;
      if (e.payload.paths.some((p) => p.endsWith(file()))) fileWritten();
    });
    offAgentWrites = onWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, ({ paths }) => {
      for (const p of paths) agentWritten.add(p);
      flushAgentWrites();
    });
  });
  onCleanup(() => {
    unlistenFs?.();
    offAgentWrites?.();
  });

  // An unchanged stretch between two hunks. Collapsed it is a single clickable
  // row; expanded it shows the real file lines, fetched on demand because the
  // diff simply does not contain them.
  function gapRow(gap: Gap, gapKey: string) {
    const count = gap.end - gap.start + 1;
    return (
      <Show
        when={openGaps().has(gapKey)}
        fallback={
          <div
            class={`${diffRowClasses.line} ${styles.diffGap}`}
            onClick={() => void expandGap(gapKey, gap)}
          >
            {`\u22ef ${count} unchanged line${count === 1 ? "" : "s"}`}
          </div>
        }
      >
        <For each={gapLines()[gapKey] ?? []}>
          {(text) =>
            twoColumn() ? (
              <div class={diffRowClasses.sideRow}>
                <div class={diffRowClasses.line}>{text || " "}</div>
                <div class={diffRowClasses.line}>{text || " "}</div>
              </div>
            ) : (
              <div class={diffRowClasses.line}>{text || " "}</div>
            )
          }
        </For>
      </Show>
    );
  }

  return (
    <div class={styles.diffView} ref={paneRef}>
      <div class={styles.topBar}>
        <span class={`${styles.status} ${styles[statusClass(entry()?.status ?? "")]}`}>
          {entry()?.status.trim() || "?"}
        </span>
        <span class={styles.name} title={file()}>
          {fileName(file())}
        </span>
        <Show when={fileDir(file())}>
          <span class={styles.dir}>{fileDir(file())}</span>
        </Show>
        <span class={styles.mode}>{staged() ? "Staged" : "Working tree"}</span>
        <Show when={editorLayout() && canStage() ? picked() : null}>
          {(sel) => (
            <Button
              size="xs"
              disabled={applying()}
              tooltip={staged() ? "Unstage only the selected lines" : "Stage only the selected lines"}
              onClick={() => {
                const hunk = hunks()[sel().hunk];
                const lines = [...sel().lines].sort((a, b) => a - b);
                void applyLines(sel().hunk, hunkFingerprint(hunk.header, hunk.lines), lines);
              }}
            >
              {linesLabel(sel().lines.size)}
            </Button>
          )}
        </Show>
        <span class={styles.spacer} />
        <Show when={editorLayout()}>
          <IconButton size="sm" icon={<Icon icon={ChevronUp} />} tooltip="Previous change" onClick={() => nav?.previous()} />
          <IconButton size="sm" icon={<Icon icon={ChevronDown} />} tooltip="Next change" onClick={() => nav?.next()} />
        </Show>
        <IconButton
          size="sm"
          icon={<Icon icon={staged() ? Minus : Plus} />}
          disabled={applying() || !entry()}
          tooltip={staged() ? "Unstage this file" : "Stage this file"}
          onClick={() =>
            void applied(() =>
              staged()
                ? unstageFiles(props.workspace, [file()])
                : stageFiles(props.workspace, [file()]),
            )
          }
        />
        <Show when={!staged()}>
          <IconButton
            size="sm"
            icon={<Icon icon={Undo2} />}
            disabled={applying() || !hunks().length || !canStage()}
            tooltipWhenDisabled={!canStage()}
            tooltip={canStage() ? "Discard every hunk below" : "Show whitespace changes to discard from here"}
            onClick={() => void discardAll()}
          />
        </Show>
        <IconButton size="sm" icon={<Icon icon={Copy} />} tooltip="Copy diff" onClick={() => void copyDiff()} />
        <IconButton
          size="sm"
          icon={<Icon icon={FileCode} />}
          tooltip="Open the file itself"
          onClick={() => emitWith(OPEN_IN_EDITOR, { path: `${props.workspace}/${file()}` })}
        />
        <IconButton
          size="sm"
          class={styles.pressable}
          aria-pressed={ignoreWhitespace()}
          icon={<Icon icon={Pilcrow} />}
          tooltip={ignoreWhitespace() ? "Show whitespace changes, which staging needs" : "Ignore whitespace changes"}
          onClick={() => writeDiffIgnoreWhitespace(!ignoreWhitespace())}
        />
        <IconButton
          size="sm"
          class={styles.pressable}
          aria-pressed={!editorLayout() && twoColumn()}
          icon={<Icon icon={Columns2} />}
          disabled={editorLayout() || paneWidth() < SIDE_BY_SIDE_MIN_WIDTH}
          // Greyed out only because the pane is too narrow, which is exactly
          // what the label says and nothing on screen otherwise does.
          tooltipWhenDisabled
          tooltip={
            editorLayout()
              ? "Side-by-side is not available in the editor layout"
              : paneWidth() < SIDE_BY_SIDE_MIN_WIDTH
                ? "Side-by-side needs a wider pane"
                : twoColumn()
                  ? "Switch to inline diff"
                  : "Switch to side-by-side diff"
          }
          onClick={() => writeSideBySide(!sideBySide())}
        />
        <IconButton
          size="sm"
          class={styles.pressable}
          aria-pressed={editorLayout()}
          icon={<Icon icon={SquareCode} />}
          tooltip={editorLayout() ? "Switch back to diff rows" : "Show the diff in the file itself"}
          onClick={() => writeDiffEditorLayout(!editorLayout())}
        />
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Re-read this diff"
          onClick={() => void reload()}
        />
      </div>
      <Show
        when={hunks().length}
        fallback={
          <div class="tree-empty">
            <Show when={!loading()}>
              <p>
                {ignoreWhitespace() && entry()
                  ? "No changes here once whitespace is ignored."
                  : staged()
                    ? "Nothing staged in this file."
                    : entry()
                      ? "No unstaged changes left in this file."
                      : "This file matches HEAD."}
              </p>
            </Show>
          </div>
        }
      >
        <Show when={!editorLayout()}>
          <div class={styles.body}>
            {/* Gaps are keyed by the hunk they follow (-1 = before the first), so
                they interleave with the hunks rather than living inside one. */}
            <For each={gaps().filter((g) => g.afterHunk === -1)}>{(gap) => gapRow(gap, "gap-1")}</For>
            <For each={hunks()}>
              {(hunk, hi) => (
                <div>
                  {/* The hunk header is the shared control anchor: it renders
                      identically inline and side-by-side, so per-hunk actions
                      land in one place in both modes. */}
                  <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${hunkStyles.hunkHeaderRow}`}>
                    <span>{hunk.header}</span>
                    <Show when={canStage()}>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={applying()}
                        tooltip={staged() ? "Unstage this hunk" : "Stage this hunk"}
                        onClick={() =>
                          // The fingerprint is derived from the hunk exactly as
                          // rendered, so the backend can prove it is still the same
                          // hunk before applying it.
                          void applyHunk(hi(), hunkFingerprint(hunk.header, hunk.lines))
                        }
                      >
                        {staged() ? "Unstage hunk" : "Stage hunk"}
                      </Button>
                      {/* Only while this hunk has lines picked, so the header stays
                          the width it always was until there is something to act
                          on. */}
                      <Show when={picked()?.hunk === hi() ? picked() : null}>
                        {(sel) => (
                          <Button
                            size="xs"
                            disabled={applying()}
                            tooltip={staged() ? "Unstage only the selected lines" : "Stage only the selected lines"}
                            onClick={() =>
                              void applyLines(
                                hi(),
                                hunkFingerprint(hunk.header, hunk.lines),
                                [...sel().lines].sort((a, b) => a - b),
                              )
                            }
                          >
                            {linesLabel(sel().lines.size)}
                          </Button>
                        )}
                      </Show>
                      <Show when={!staged()}>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={applying()}
                          tooltip="Throw away this hunk"
                          onClick={() => void discardHunk(hi(), hunkFingerprint(hunk.header, hunk.lines))}
                        >
                          Discard hunk
                        </Button>
                      </Show>
                    </Show>
                    <HunkCommentInput
                      target={target()}
                      disabledReason={disabledReason()}
                      filePath={`${props.workspace}/${file()}`}
                      startLine={hunk.startLine}
                      endLine={hunk.endLine}
                    />
                  </div>
                  <DiffRows
                    rows={buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine })}
                    path={file()}
                    twoColumn={twoColumn()}
                    selection={
                      canStage()
                        ? {
                            has: (i) => picked()?.hunk === hi() && picked()!.lines.has(i),
                            toggle: (i) => pickLine(hi(), i),
                          }
                        : undefined
                    }
                  />
                  <For each={gaps().filter((g) => g.afterHunk === hi())}>
                    {(gap) => gapRow(gap, `gap${hi()}`)}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={editorLayout() && fileText() !== null}>
          <Breadcrumbs
            root={props.workspace}
            path={`${props.workspace}/${file()}`}
            member={props.member}
            caret={caret()}
            trailing={
              <Show when={!staged()}>
                <IconButton
                  size="sm"
                  aria-pressed={blameOn()}
                  icon={<Icon icon={UserRound} class={blameOn() ? crumbStyles.barToggleOn : undefined} />}
                  onClick={() => writeBlamePref(!blameOn())}
                  tooltip={
                    blameOn()
                      ? "Showing git blame: who last changed each line, shaded by age. Click to hide."
                      : "Git blame: show who last changed each line, shaded by age."
                  }
                />
              </Show>
            }
          />
          <DiffBufferView
            text={fileText()!}
            hunks={hunks()}
            path={file()}
            staged={staged()}
            busy={applying()}
            canStage={canStage()}
            blame={blame()}
            onCaret={(line, column) => setCaret({ line, column })}
            controls={(n) => (nav = n)}
            onHunk={(index, action) => {
              const hunk = hunks()[index];
              const fingerprint = hunkFingerprint(hunk.header, hunk.lines);
              void (action === "apply" ? applyHunk(index, fingerprint) : discardHunk(index, fingerprint));
            }}
            onSelect={(groups) =>
              setPicked(groups.length === 1 ? { hunk: groups[0].hunk, lines: new Set(groups[0].lines) } : null)
            }
          />
        </Show>
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

  /** Discard every hunk in the file, in one patch, so a half-applied reverse
   *  cannot leave the file in a state neither the diff nor HEAD describes. */
  async function discardAll() {
    if (applying()) return;
    const list = hunks();
    if (!list.length) return;
    const ok = await askConfirm({
      title: "Discard all unstaged changes to this file?",
      message: `Every change to ${file()} below goes away. None of it is staged, so git has no other copy.\n\nTori saves a snapshot first, so you can bring it back from Undo history in the timeline.`,
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (!ok) return;
    setApplying(true);
    try {
      const outcome = await invoke<DiscardOutcome>("git_discard_hunks", {
        projectPath: props.workspace,
        file: file(),
        hunkIndices: list.map((_, i) => i),
        fingerprints: list.map((h) => hunkFingerprint(h.header, h.lines)),
        context: DIFF_CONTEXT,
      });
      props.onReverted?.({
        backstop_ts: outcome.backstop_ts,
        restored: outcome.restored,
        deleted: outcome.deleted,
      });
      await Promise.all([refreshStatus(props.workspace), reload()]);
    } catch (e) {
      await reload();
      toastError(e);
    } finally {
      setApplying(false);
    }
  }
}
