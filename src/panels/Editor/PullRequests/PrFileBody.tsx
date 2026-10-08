// One file of a pull request: its hunks, the conversations anchored to them,
// and the composer for writing a new one.
//
// ## Two sources, on purpose
//
// The **patches come from the API**. Not from a local `git diff`, even though
// the commits are (or can be) right here: a review thread anchors to the
// `diff_hunk` and position GitHub computed, and a locally recomputed diff would
// differ in context size, rename detection and whitespace handling. Each of
// those differences puts a comment on a wrong line rather than failing outright.
//
// The **unchanged regions come from git**. A patch carries three lines of
// context either side and nothing else, so expanding a collapsed stretch means
// reading the file at the PR's head. `git fetch origin pull/{n}/head` puts that
// commit in the local object store using the credentials the auth layer already
// has, which makes every expansion free: no API quota, no poll-layer governor,
// and no dependence on the branch being checked out.
//
// ## Why every row is commentable
//
// There is no "start a review" gate. A gate means the affordance is missing at
// the moment somebody has something to say, and it bought nothing: what it was
// really guarding against was `DiffRows` handing a tab stop to every line of a
// four-thousand-row diff, and `keyboard: "roving"` answers that directly by
// giving the hunk one.

import { createEffect, createMemo, createSignal, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../../utils/diffHunks";
import { buildRows, hunkGaps, type DiffRow, type Gap } from "../../../utils/diffView";
import { fileSkip, fileLabel, type FileSkip } from "../../../utils/prFiles";
import { groupThreads, newSideLines, oldSideLines, splitByRenderedLines } from "../../../utils/reviewThreads";
import { anchorFor, anchorLabel } from "../../../utils/pendingReview";
import { forgeCapabilities } from "../../../utils/forgeStatus";
import {
  addPending,
  closeComposer,
  composerText,
  ensurePrHead,
  gapLines,
  gapOpen,
  headDrift,
  noteGapLines,
  prEntry,
  setComposerText,
  setGapOpen,
  type DraftAnchor,
} from "../../../utils/prReviewStore";
import {
  forgeErrorMessage,
  type DraftComment,
  type PrFile,
  type PullRequest,
  type ReviewThread,
} from "../../../utils/forgeTypes";
import DiffRows, { diffRowClasses, rovingHunk } from "../DiffRows";
import HunkProvenance, { createOpenHunks, WhyToggle } from "../HunkProvenance";
import { claimsVia, type ClaimReader } from "../../../utils/provenance";
import hunkStyles from "../HunkCommentInput.module.css";
import PrThreadCard from "./PrThreadCard";
import Button from "../../../components/Button/Button";
import styles from "./PrFileBody.module.css";

/** A blob size as a reader reads it. Rounded, because the point is the shape of
 *  the change and not the byte. */
function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Which rows are picked, and in which hunk. One hunk at a time, like the
 *  Changes panel's line staging: a comment anchors within a single hunk's
 *  numbering, so a range spanning two of them could not be one comment. */
type Picked = { hunk: number; from: number; to: number };

export default function PrFileBody(props: {
  root: string;
  pr: PullRequest;
  file: PrFile;
  twoColumn: boolean;
  /** This file's outdated conversations, when the surface has nowhere else to
   *  put them. The panel keeps a pull-request-wide group; a diff tab is one
   *  file, so they belong in its strip or nowhere. */
  outdated?: ReviewThread[];
}) {
  // What went wrong in this file's body, from expanding a gap or from posting
  // a single comment. One line because there is one place to put it; the name
  // says "this file", not which of the two noticed.
  const [failure, setFailure] = createSignal<string | null>(null);
  const [picked, setPicked] = createSignal<Picked | null>(null);
  const whyOpen = createOpenHunks();

  const entry = createMemo(() => prEntry(props.root, props.pr.number));
  const grouped = createMemo(() => groupThreads(entry().threads));
  const capabilities = createMemo(() => forgeCapabilities(props.root));
  const drifted = () => headDrift(props.root, props.pr.number);

  const hunks = createMemo(() => parseDiffHunks(props.file.patch ?? ""));
  const gaps = createMemo(() => hunkGaps(hunks()));
  const skip = createMemo(() => fileSkip(props.file));
  // Every line this file's hunks actually render, so a thread anchored outside
  // them is held back rather than dropped.
  const rendered = createMemo(() => hunks().flatMap((h) => newSideLines(h)));
  const placed = createMemo(() => splitByRenderedLines(grouped().byLine.get(props.file.path), rendered()));

  // A different file means a different set of rows, so a selection made against
  // the old one names lines that are not there.
  createEffect(
    on(
      () => props.file.path,
      () => {
        setPicked(null);
        whyOpen.clear();
      },
      { defer: true },
    ),
  );

  const prClaims: ClaimReader = async (hunk) => {
    try {
      await ensurePrHead(props.root, props.pr.number, props.pr.headSha);
    } catch (e) {
      return { error: forgeErrorMessage(e) };
    }
    return claimsVia("pr_provenance", {
      projectPath: props.root,
      headRef: props.pr.headRef,
      headSha: props.pr.headSha,
      headRepoIsOrigin: props.pr.headRepoIsOrigin,
      file: props.file.path,
    })(hunk);
  };

  // Reveal an unchanged stretch, read from the PR's head rather than from the
  // working tree: the head is usually not checked out, so the file on disk would
  // give the right line numbers over the wrong content.
  async function expandGap(key: string, gap: Gap) {
    if (gapOpen(props.root, props.pr.number, key)) {
      setGapOpen(props.root, props.pr.number, key, false);
      return;
    }
    if (!gapLines(props.root, props.pr.number, key)) {
      try {
        await ensurePrHead(props.root, props.pr.number, props.pr.headSha);
      } catch (e) {
        setFailure(forgeErrorMessage(e));
        return;
      }
      try {
        const lines = await invoke<string[]>("git_blob_slice", {
          projectPath: props.root,
          rev: props.pr.headSha,
          file: props.file.path,
          start: gap.start,
          end: gap.end,
        });
        // Rendered as context, so they carry the leading space a context line
        // in a real diff would have.
        noteGapLines(
          props.root,
          props.pr.number,
          key,
          lines.map((l) => ` ${l}`),
        );
      } catch (e) {
        // A click that visibly does nothing is the worst way to report this.
        setFailure(forgeErrorMessage(e));
        return;
      }
    }
    setFailure(null);
    setGapOpen(props.root, props.pr.number, key, true);
  }

  function gapRow(gap: Gap, key: string) {
    const count = gap.end - gap.start + 1;
    return (
      <Show
        when={gapOpen(props.root, props.pr.number, key)}
        fallback={
          <div class={`${diffRowClasses.line} ${styles.diffGap}`} onClick={() => void expandGap(key, gap)}>
            {`⋯ ${count} unchanged line${count === 1 ? "" : "s"}`}
          </div>
        }
      >
        <For each={gapLines(props.root, props.pr.number, key) ?? []}>
          {(text) =>
            props.twoColumn ? (
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

  /** One hunk's rows, cut at every line a thread is anchored to, so the
   *  conversation sits between the line it is about and the one after it.
   *
   *  Cut rather than interleave: `DiffRows` owns the markup and the two-column
   *  layout, and a card threaded through its grid would have to break out of it.
   *  Rendering consecutive slices puts the card between two blocks, which lands
   *  in the same place in both layouts. The cost is that a `-`/`+` pair split
   *  across a cut renders unpaired side-by-side, which needs a comment on a
   *  deleted line inside a change block to reach at all. */
  function hunkSegments(
    rows: DiffRow[],
    lines: (number | null)[],
    shown: Map<number, ReviewThread[]>,
  ): { rows: DiffRow[]; after: ReviewThread[]; offset: number }[] {
    const out: { rows: DiffRow[]; after: ReviewThread[]; offset: number }[] = [];
    let from = 0;
    rows.forEach((_, i) => {
      const line = lines[i];
      const at = line === null ? undefined : shown.get(line);
      if (!at) return;
      out.push({ rows: rows.slice(from, i + 1), after: at, offset: from });
      from = i + 1;
    });
    if (from < rows.length) out.push({ rows: rows.slice(from), after: [], offset: from });
    return out;
  }

  /** Open the composer on a row, or grow the open range to reach it.
   *
   *  A range only means something inside one hunk, so reaching into a different
   *  one starts again rather than spanning the two. */
  function startComment(hunk: number, index: number, extend: boolean) {
    setPicked((was) =>
      extend && was && was.hunk === hunk ? { hunk, from: was.from, to: index } : { hunk, from: index, to: index },
    );
  }

  /** Hold the drafted line comment. Nothing is posted: it joins the review and
   *  goes out with the verdict, in one call.
   *
   *  The row it was written against travels with it. A line number alone still
   *  resolves after the file changes underneath it, so without the text there is
   *  nothing left to notice that the comment has come to describe something
   *  else. */
  function hold(anchor: DraftAnchor, rowText: string) {
    const body = composerText(props.root, props.pr.number, anchor).trim();
    if (!body) return;
    addPending(props.root, props.pr.number, { ...anchor, body, rowText });
    closeComposer(props.root, props.pr.number, anchor);
    setPicked(null);
  }

  /// Post one comment on its own, outside the held review.
  ///
  /// A separate path from `submit_review` and not a shortcut through it: this
  /// one carries `commit_id`, so the server anchors it against the commit the
  /// patch on screen came from rather than against whatever the head is by the
  /// time it arrives. That is also why drift disables it.
  const [posting, setPosting] = createSignal(false);
  async function postSingle(anchor: DraftAnchor) {
    const body = composerText(props.root, props.pr.number, anchor).trim();
    if (!body) return;
    setPosting(true);
    try {
      await invoke<void>("forge_add_review_comment", {
        projectPath: props.root,
        number: props.pr.number,
        commitId: entry().headSha,
        comment: { ...anchor, body } satisfies DraftComment,
      });
      closeComposer(props.root, props.pr.number, anchor);
      setPicked(null);
    } catch (e) {
      setFailure(forgeErrorMessage(e));
    } finally {
      setPosting(false);
    }
  }

  /// Conversations this file has and these rows cannot carry.
  ///
  /// Two different reasons, deliberately in one strip. `offDiff` is current and
  /// correct and simply lands in a stretch the patch does not cover; an outdated
  /// one was written against a version of the file that has moved on. Neither
  /// may be placed on a guessed line, and neither may be dropped: a file that
  /// visibly has a conversation must not appear to have none.
  const stranded = createMemo(() => [...placed().offDiff, ...(props.outdated ?? [])]);

  /// Byte sizes for the one case with no text to show them instead.
  ///
  /// Read lazily and only for a binary file: every other case has a diff or a
  /// sentence that says everything, and a `git cat-file` per file of a
  /// three-hundred-file pull request would be three hundred processes for
  /// nothing. Null stays null, which renders as no size line at all rather than
  /// as zero bytes.
  const [sizes, setSizes] = createSignal<{ head: number | null; base: number | null } | null>(null);
  createEffect(
    on([() => props.file.path, skip], async ([, why]) => {
      setSizes(null);
      if (why !== "noText") return;
      try {
        await ensurePrHead(props.root, props.pr.number, props.pr.headSha);
        const got = await invoke<{ head: number | null; base: number | null }>("git_blob_sizes", {
          projectPath: props.root,
          head: props.pr.headSha,
          // The remote's base, not this checkout's branch of that name: a local
          // `main` is whatever the reader last pulled. Rust takes the merge
          // base from here, and answers with no size when it cannot.
          base: `origin/${props.pr.baseRef}`,
          path: props.file.path,
        });
        setSizes(got);
      } catch {
        // The sentence above it is the answer; a size is an extra the reader
        // can do without, and an error line about `cat-file` would not help.
      }
    }),
  );

  const SKIP_TITLE: Record<FileSkip, string> = {
    tooLarge: "Diff too large to load",
    moved: "Renamed, contents unchanged",
    noText: "Binary file, nothing to diff",
  };

  function skipBody(why: FileSkip) {
    if (why === "moved") {
      return `${fileLabel(props.file)}. Every line is identical, so there is nothing to review here.`;
    }
    if (why === "noText") {
      const each = sizes();
      const said = [
        each?.base != null ? `${kb(each.base)} before` : null,
        each?.head != null ? `${kb(each.head)} after` : null,
      ].filter(Boolean);
      const where = said.length ? `${said.join(", ")}. ` : "";
      return `${where}Tori does not render image diffs yet, and git has no text patch for this file.`;
    }
    return "This patch is past the size the API will send. The change is real, it is just not here.";
  }

  return (
    <div class={styles.fileDiff}>
      <Show when={failure()}>{(message) => <div class={styles.error}>{message()}</div>}</Show>

      {/* Before the first hunk, never after: a reader who scrolls a long file
          and finds this at the bottom has already formed a view of what the
          file's conversation is. */}
      <Show when={stranded().length}>
        <div class={styles.stranded} data-group="stranded">
          <div class={styles.groupTitle}>
            {stranded().length === 1
              ? "1 conversation is not on a line shown here"
              : `${stranded().length} conversations are not on a line shown here`}
          </div>
          <For each={stranded()}>{(t) => <PrThreadCard root={props.root} pr={props.pr} thread={t} quoteHunk />}</For>
        </div>
      </Show>

      <Show when={skip()}>
        {(why) => (
          <div class={styles.skip} data-file-skip={why()}>
            <div class={styles.skipTitle}>{SKIP_TITLE[why()]}</div>
            <div class={styles.skipBody}>{skipBody(why())}</div>
            {/* Only the withheld patch is content the reader cannot get here. A
                moved or binary file is complete as it stands, and offering a way
                out of it would imply otherwise. */}
            <Show when={why() === "tooLarge"}>
              <a href={`${props.pr.url}/files`} target="_blank" rel="noreferrer">
                View on github.com
              </a>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!skip()}>
        <For each={gaps().filter((g) => g.afterHunk === -1)}>{(gap) => gapRow(gap, `${props.file.path}:-1`)}</For>
        <For each={hunks()}>
          {(hunk, hi) => {
            // Both memoised, and for different reasons. `buildRows` does the
            // word-level pairing and is the most expensive thing on screen for
            // a large patch, while being a pure function of text that never
            // changes; recomputing it on a column toggle or a gap expansion is
            // pure waste. The segments then change only when a thread appears
            // at a new line, so the diff's DOM survives everything else.
            const rows = createMemo(() => buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine }));
            const lines = createMemo(() => newSideLines(hunk));
            const oldLines = createMemo(() => oldSideLines(hunk));
            const segments = createMemo(() => hunkSegments(rows(), lines(), placed().shown));
            // One holder for the hunk, handed to every piece a thread cuts it
            // into, so the pieces are one hunk to the keyboard as they are to
            // the eye rather than a tab stop each.
            const hunkRoving = rovingHunk();
            const mine = createMemo(() => {
              const p = picked();
              return p && p.hunk === hi() ? p : null;
            });
            const anchor = createMemo(() => {
              const p = mine();
              if (!p) return null;
              return anchorFor({
                path: props.file.path,
                rows: rows(),
                newLines: lines(),
                oldLines: oldLines(),
                selected: [p.from, p.to],
              });
            });
            // The raw diff line the anchor sits on, index-aligned with the rows
            // (`reviewThreads.ts` explains why that holds). It travels with the
            // comment so a later read of the patch can tell an anchor that still
            // fits from one whose line now says something else.
            const anchorRow = () => {
              const p = mine();
              return p ? (hunk.lines[Math.max(p.from, p.to)] ?? "") : "";
            };
            // "Add a comment on", not "Comment on": the composer this opens is
            // labelled "Comment on <anchor>", and two controls whose names
            // start the same way are two controls a screen reader user has to
            // tell apart by listening to the end of both.
            const lineLabel = (index: number) => {
              const at = lines()[index] ?? oldLines()[index];
              return at === null || at === undefined
                ? `Add a comment on this line of ${props.file.path}`
                : `Add a comment on line ${at} of ${props.file.path}`;
            };
            return (
              <div>
                <div class={`${diffRowClasses.line} ${diffRowClasses.hunk} ${hunkStyles.hunkHeaderRow}`}>
                  <span class={hunkStyles.hunkHeaderText}>{hunk.header}</span>
                  <WhyToggle open={whyOpen.has(hi())} onClick={() => whyOpen.toggle(hi())} />
                </div>
                <Show when={whyOpen.has(hi())}>
                  <HunkProvenance file={props.file.path} hunk={hunk} read={prClaims} />
                </Show>
                <For each={segments()}>
                  {(seg) => (
                    <>
                      <DiffRows
                        rows={seg.rows}
                        path={props.file.path}
                        twoColumn={props.twoColumn}
                        keyboard="roving"
                        roving={hunkRoving}
                        offset={seg.offset}
                        comment={{
                          // Segment-relative indices are what `DiffRows` counts
                          // in; the anchor is measured against the whole hunk.
                          onComment: (i, extend) => startComment(hi(), seg.offset + i, extend),
                          label: (i) => lineLabel(seg.offset + i),
                        }}
                        onRowKey={(i, e) => {
                          if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return false;
                          startComment(hi(), seg.offset + i, e.shiftKey);
                          return true;
                        }}
                      />
                      <For each={seg.after}>{(t) => <PrThreadCard root={props.root} pr={props.pr} thread={t} />}</For>
                    </>
                  )}
                </For>
                {/* The anchor is spelled out because a selection spanning both
                    sides narrows to one line, and a silent narrowing is a
                    comment that lands somewhere other than where it was drawn. */}
                <Show when={anchor()}>
                  {(a) => (
                    <div class={styles.composer}>
                      <span class={styles.anchor}>{anchorLabel(a())}</span>
                      <textarea
                        class={styles.composerInput}
                        rows={2}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        aria-label={`Comment on ${anchorLabel(a())}`}
                        value={composerText(props.root, props.pr.number, a())}
                        onInput={(e) => setComposerText(props.root, props.pr.number, a(), e.currentTarget.value)}
                        onKeyDown={(e: KeyboardEvent) => {
                          // Closes the composer and keeps what is in it: the
                          // text lives in the store under this anchor, so
                          // reopening the row hands it back.
                          if (e.key === "Escape") setPicked(null);
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            hold(a(), anchorRow());
                          }
                        }}
                      />
                      <div class={styles.composerActions}>
                        <Button variant="ghost" onClick={() => setPicked(null)}>
                          Cancel
                        </Button>
                        {/* Absent where the host has no such call, disabled
                            where it has one that would anchor against a commit
                            this patch is not from. */}
                        <Show when={capabilities()?.singleComment ?? false}>
                          <Button
                            variant="ghost"
                            disabled={posting() || drifted() || !composerText(props.root, props.pr.number, a()).trim()}
                            tooltipWhenDisabled
                            tooltip={
                              drifted()
                                ? "This pull request has new commits since these lines were read"
                                : "Post this comment on its own, now"
                            }
                            onClick={() => void postSingle(a())}
                          >
                            Add single comment
                          </Button>
                        </Show>
                        <Button
                          onClick={() => hold(a(), anchorRow())}
                          disabled={!composerText(props.root, props.pr.number, a()).trim()}
                        >
                          Add to review
                        </Button>
                      </div>
                    </div>
                  )}
                </Show>
                <For each={gaps().filter((g) => g.afterHunk === hi())}>
                  {(gap) => gapRow(gap, `${props.file.path}:${hi()}`)}
                </For>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
