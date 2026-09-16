// One pull request, opened from a row in the list: its files, and the diff of
// each.
//
// ## Two sources, on purpose
//
// The **patches come from the API**. Not from a local `git diff`, even though
// the commits are (or can be) right here: a review thread anchors to the
// `diff_hunk` and position GitHub computed, and a locally recomputed diff would
// differ in context size, rename detection and whitespace handling. Each of
// those differences puts a comment on a wrong line rather than failing outright,
// which is the failure mode Phase 10 cannot recover from.
//
// The **unchanged regions come from git**. A patch carries three lines of
// context either side and nothing else, so expanding a collapsed stretch means
// reading the file at the PR's head. `git fetch origin pull/{n}/head` puts that
// commit in the local object store using the credentials layer 1 already has,
// which makes every expansion free: no API quota, no poll-layer governor, and
// no dependence on the branch being checked out.

import { createSignal, createEffect, createMemo, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "../../../utils/diffHunks";
import { buildRows, hunkGaps, type DiffRow, type Gap } from "../../../utils/diffView";
import { fileSkip, fileLabel, type FileSkip } from "../../../utils/prFiles";
import {
  groupThreads,
  newSideLines,
  oldSideLines,
  pendingComment,
  splitByRenderedLines,
  withComment,
  withoutComment,
  withResolved,
} from "../../../utils/reviewThreads";
import { anchorFor, anchorLabel, isSelfAuthored } from "../../../utils/pendingReview";
import { composeThreadAsk } from "../../../utils/threadAsk";
import { BLOCKED_REASON, requestSend, type SessionTarget } from "../../../utils/safeSend";
import { branchOwner, projectUnitFor, sessionStatus } from "../../../utils/sessionActivity";
import { emitWith, REMOVE_BRANCH_UNIT, type RemoveBranchUnit } from "../../../utils/events";
import { STATUS_LABEL } from "../../../utils/sessionStatus";
import { findAdapter } from "../../../utils/agents";
import { agentOffReason } from "../../../utils/agentEnabled";
import { forgeCapabilities, forgeViewer, pollNow } from "../../../utils/forgeStatus";
import {
  forgeErrorMessage,
  type DraftComment,
  type Paged,
  type PrFile,
  type MergeableState,
  type MergeMethod,
  type PullRequest,
  type ReviewComment,
  type ReviewEvent,
  type ReviewThread,
} from "../../../utils/forgeTypes";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../../utils/sideBySide";
import DiffRows, { diffRowClasses } from "../DiffRows";
import ReviewThreadView from "./ReviewThreadView";
import ReviewBar from "./ReviewBar";
import MergeBar from "./MergeBar";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Tooltip from "../../../components/Tooltip/Tooltip";
import styles from "./PrDetail.module.css";

/** The sentence for each reason a file shows no diff. Three situations arrive
 *  as the same `patch: null`, and only one of them means something is missing;
 *  see `prFiles.ts` for how they are told apart. */
const SKIP_COPY: Record<FileSkip, string> = {
  tooLarge: "This file's diff is larger than the API will send.",
  moved: "Moved, with no change to its contents.",
  noText: "No line changes to show (a binary file, or a mode change).",
};

export default function PrDetail(props: {
  root: string;
  pr: PullRequest;
  onBack: () => void;
  /** Called once this pull request has been landed. The list behind this view
   *  still has it open: Rust drops its caches on a merge, but the panel is
   *  holding an array it fetched before, and going back to find the pull request
   *  you just merged still sitting there is the one place the user checks. */
  onLanded: () => void;
}) {
  const [files, setFiles] = createSignal<PrFile[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [openGaps, setOpenGaps] = createSignal<ReadonlySet<string>>(new Set());
  const [gapLines, setGapLines] = createSignal<Record<string, string[]>>({});
  const [gapError, setGapError] = createSignal<string | null>(null);

  // Review conversations. Their own request, and a failure of it must not take
  // the diff down with it: a pull request whose threads could not be read is
  // still a pull request worth reading.
  const [threads, setThreads] = createSignal<ReviewThread[]>([]);
  const [threadsTruncated, setThreadsTruncated] = createSignal(false);
  const [threadError, setThreadError] = createSignal<string | null>(null);
  const [busyThread, setBusyThread] = createSignal<string | null>(null);
  const grouped = createMemo(() => groupThreads(threads()));

  // The review being written. Held here and posted in one call, because a review
  // is atomic on the server: posting comments as they are written and the
  // verdict at the end leaves a half-submitted review behind whenever the last
  // call fails, with nothing saying which comments already landed.
  const [pending, setPending] = createSignal<DraftComment[]>([]);
  const [reviewBody, setReviewBody] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  // Which rows are picked, and in which hunk. One hunk at a time, like the
  // Changes panel's line staging: a comment anchors within a single hunk's
  // numbering, so a selection spanning two of them could not be one comment.
  const [picked, setPicked] = createSignal<{
    path: string;
    hunk: number;
    lines: ReadonlySet<number>;
  } | null>(null);
  const [draftBody, setDraftBody] = createSignal("");
  const [reviewOpen, setReviewOpen] = createSignal(false);

  const reviewing = () => reviewOpen() || pending().length > 0;
  const selfAuthored = createMemo(() => isSelfAuthored(props.pr, forgeViewer(props.root)));
  const capabilities = createMemo(() => forgeCapabilities(props.root));

  // Handing a thread back to the agent that wrote the branch. Which thread is in
  // flight, and how the last attempt on each went. Per thread rather than one
  // panel-wide line, because a reader who sent three of them needs to know which
  // one did not land.
  const [sendingThread, setSendingThread] = createSignal<string | null>(null);
  const [sendNotes, setSendNotes] = createSignal<Record<string, { text: string; ok: boolean }>>({});

  // Landing it. `null` is "nobody has asked yet", which is not `"unknown"`
  // ("GitHub has not decided"): one is a blank the UI must not render as a
  // verdict, the other is a verdict.
  const [mergeState, setMergeState] = createSignal<MergeableState | null>(null);
  const [mergeBusy, setMergeBusy] = createSignal(false);
  const [mergeError, setMergeError] = createSignal<string | null>(null);
  const [merged, setMerged] = createSignal(false);
  const [paneWidth, setPaneWidth] = createSignal(Infinity);
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;

  // Which read is current. The panel reuses this component when a different PR
  // is opened, so a slow answer can land after the one that replaced it and put
  // one PR's files under another's number.
  let current = 0;
  // Whether the head commit has been made local yet. Once per PR, and lazily:
  // most readers never expand a gap at all, and a PR on a branch checked out
  // right here needs no fetch even then.
  let headFetch: Promise<void> | null = null;
  // Distinguishes two replies in flight at once, so each reconciles onto its own
  // optimistic comment rather than onto whichever was appended last.
  let replySeq = 0;

  createEffect(
    on([() => props.root, () => props.pr.number], async ([root, number]) => {
      const mine = ++current;
      setOpenFile(null);
      setOpenGaps(new Set<string>());
      setGapLines({});
      setGapError(null);
      headFetch = null;
      setThreads([]);
      setThreadsTruncated(false);
      setThreadError(null);
      setBusyThread(null);
      setPending([]);
      setReviewBody("");
      setPicked(null);
      setDraftBody("");
      setReviewOpen(false);
      setSendingThread(null);
      setSendNotes({});
      setMergeState(null);
      setMergeBusy(false);
      setMergeError(null);
      setMerged(false);
      setLoading(true);
      setError(null);
      try {
        const page = await invoke<Paged<PrFile>>("forge_pr_files", {
          projectPath: root,
          number,
        });
        if (mine !== current) return;
        setFiles(page.items);
        setTruncated(page.truncated);
      } catch (e) {
        if (mine !== current) return;
        setFiles([]);
        setTruncated(false);
        setError(forgeErrorMessage(e));
      } finally {
        if (mine === current) setLoading(false);
      }

      // Independent reads, so neither waits on the other. The merge bar is the
      // topmost control on the surface, and holding it behind a thread request
      // it has nothing to do with is latency for nothing.
      await Promise.all([loadThreads(root, number, mine), loadMergeability(root, number, mine)]);
    }),
  );

  /// The server's verdict, on its own request and with its own silence on
  /// failure.
  ///
  /// Read here rather than from `props.pr.mergeableState`, even though the list
  /// carries one: that field came from the listing, and by the time somebody has
  /// opened a pull request and read its diff the base may have moved twice. The
  /// merge button is the one control where a stale green light costs something.
  ///
  /// A failure leaves the state `null`, which renders as "checking" with the
  /// button inert. That is the honest shape: not asking and being told "no" are
  /// different, and only one of them should be dressed as a verdict.
  async function loadMergeability(root: string, number: number, mine: number) {
    try {
      const state = await invoke<MergeableState>("forge_mergeability", {
        projectPath: root,
        number,
      });
      if (mine === current) setMergeState(state);
    } catch {
      // Deliberately silent. The diff and the conversations are worth reading on
      // a pull request whose mergeability could not be fetched, and an error
      // banner over all of them would say otherwise.
    }
  }

  /** Its own request and its own failure. Threads that will not load must not
   *  take the diff down with them. Re-run after a submit, whose comments open
   *  threads this list has never seen. */
  async function loadThreads(root: string, number: number, mine: number) {
    try {
      const page = await invoke<Paged<ReviewThread>>("forge_review_threads", {
        projectPath: root,
        number,
      });
      if (mine !== current) return;
      setThreads(page.items);
      setThreadsTruncated(page.truncated);
    } catch (e) {
      if (mine !== current) return;
      setThreadError(forgeErrorMessage(e));
    }
  }

  /** Post a reply, showing it at once and then correcting it with what the
   *  server stored. The rollback is the half that matters: a reply left on
   *  screen after a refusal is a comment only its author can see. */
  async function reply(threadId: string, body: string) {
    // Same staleness guard as the two loads. A stale thread id already matches
    // nothing in the new list, so it is the *message* that would otherwise land:
    // a refusal from the pull request you just navigated away from, posted onto
    // the one now on screen.
    const mine = current;
    const pending = pendingComment(body, ++replySeq);
    setThreads((list) => withComment(list, threadId, pending));
    try {
      const stored = await invoke<ReviewComment>("forge_reply_to_thread", {
        projectPath: props.root,
        threadId,
        body,
      });
      if (mine !== current) return;
      setThreads((list) => withComment(list, threadId, stored, pending.id));
    } catch (e) {
      if (mine !== current) return;
      setThreads((list) => withoutComment(list, threadId, pending.id));
      setThreadError(forgeErrorMessage(e));
    }
  }

  /** Resolve or unresolve. Not optimistic: unlike a reply there is nothing to
   *  read while it lands, and a card that flips back on refusal reads as a
   *  click that did the opposite of what it said. */
  async function setResolved(threadId: string, resolved: boolean) {
    const mine = current;
    setBusyThread(threadId);
    try {
      await invoke<void>("forge_set_thread_resolved", {
        projectPath: props.root,
        threadId,
        resolved,
      });
      if (mine !== current) return;
      setThreads((list) => withResolved(list, threadId, resolved));
      setThreadError(null);
    } catch (e) {
      if (mine !== current) return;
      setThreadError(forgeErrorMessage(e));
    } finally {
      if (mine === current) setBusyThread(null);
    }
  }

  function toggleFile(path: string) {
    setOpenFile(openFile() === path ? null : path);
  }

  /** Put the PR's head commit in the local object store, once. Rust skips the
   *  network entirely when the commit is already there. */
  function ensureHead(): Promise<void> {
    if (!headFetch) {
      headFetch = invoke<void>("git_fetch_pr_head", {
        projectPath: props.root,
        number: props.pr.number,
        sha: props.pr.headSha,
      });
    }
    return headFetch;
  }

  // Reveal an unchanged stretch, read from the PR's head rather than from the
  // working tree: the head is usually not checked out, so the file on disk would
  // give the right line numbers over the wrong content.
  async function expandGap(key: string, path: string, gap: Gap) {
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
        await ensureHead();
      } catch (e) {
        // No network, or a PR ref the remote will not serve. Only *this* is
        // reason to forget the fetch: clearing it for a failed read below would
        // re-fetch a commit that arrived perfectly well.
        headFetch = null;
        setGapError(forgeErrorMessage(e));
        return;
      }
      try {
        const lines = await invoke<string[]>("git_blob_slice", {
          projectPath: props.root,
          rev: props.pr.headSha,
          file: path,
          start: gap.start,
          end: gap.end,
        });
        // Rendered as context, so they carry the leading space a context line
        // in a real diff would have.
        setGapLines((prev) => ({ ...prev, [key]: lines.map((l) => ` ${l}`) }));
      } catch (e) {
        // A click that visibly does nothing is the worst way to report this.
        setGapError(forgeErrorMessage(e));
        return;
      }
    }
    setGapError(null);
    setOpenGaps((prev) => new Set(prev).add(key));
  }

  function toggleColumns() {
    writeSideBySide(!sideBySide());
  }

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  function gapRow(gap: Gap, key: string, path: string) {
    const count = gap.end - gap.start + 1;
    return (
      <Show
        when={openGaps().has(key)}
        fallback={
          <div
            class={`${diffRowClasses.line} ${styles.diffGap}`}
            onClick={() => void expandGap(key, path, gap)}
          >
            {`⋯ ${count} unchanged line${count === 1 ? "" : "s"}`}
          </div>
        }
      >
        <For each={gapLines()[key] ?? []}>
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
  ): { rows: DiffRow[]; after: ReviewThread[] }[] {
    const out: { rows: DiffRow[]; after: ReviewThread[] }[] = [];
    let from = 0;
    rows.forEach((_, i) => {
      const line = lines[i];
      const at = line === null ? undefined : shown.get(line);
      if (!at) return;
      out.push({ rows: rows.slice(from, i + 1), after: at });
      from = i + 1;
    });
    if (from < rows.length) out.push({ rows: rows.slice(from), after: [] });
    return out;
  }

  /** Pick or unpick one row of one hunk. Switching hunks starts a fresh
   *  selection rather than merging: the anchor lives inside a hunk. */
  function togglePick(path: string, hunk: number, index: number) {
    setPicked((was) => {
      const same = was && was.path === path && was.hunk === hunk;
      const lines = new Set(same ? was!.lines : []);
      if (lines.has(index)) lines.delete(index);
      else lines.add(index);
      if (!lines.size) return null;
      return { path, hunk, lines };
    });
  }

  /** Hold the drafted line comment. Nothing is posted: it joins the review and
   *  goes out with the verdict, in one call. */
  function holdComment(anchor: Omit<DraftComment, "body">) {
    const body = draftBody().trim();
    if (!body) return;
    setPending((list) => [...list, { ...anchor, body }]);
    setDraftBody("");
    setPicked(null);
  }

  async function submitReview(event: ReviewEvent) {
    const mine = current;
    setSubmitting(true);
    try {
      await invoke<void>("forge_submit_review", {
        projectPath: props.root,
        number: props.pr.number,
        event,
        body: reviewBody(),
        comments: pending(),
      });
      if (mine !== current) return;
      // Only now. A failed submit has to hand the whole set back, or the
      // reader loses every comment they wrote to one refusal.
      setPending([]);
      setReviewBody("");
      setReviewOpen(false);
      setThreadError(null);
      // The verdict the sidebar chip reads is the server's, and it has changed.
      void pollNow("manual");
      // The review's own comments open new threads, which this list has not
      // seen. Its own request, and its failure is already handled there.
      void loadThreads(props.root, props.pr.number, mine);
    } catch (e) {
      if (mine !== current) return;
      setThreadError(forgeErrorMessage(e));
    } finally {
      if (mine === current) setSubmitting(false);
    }
  }

  /** How many anchored conversations a file carries. Outdated ones are counted
   *  in their own group instead, since the file's rows do not show them. */
  function threadCount(path: string): number {
    let n = 0;
    for (const at of grouped().byLine.get(path)?.values() ?? []) n += at.length;
    return n;
  }

  // --- handing a thread to the agent that owns the branch --------------------

  /// The session a remark about this pull request should reach.
  ///
  /// The branch, not the selection. Every other safe-send surface in the app
  /// composes for whatever session is selected, because it is looking at that
  /// session's own working tree; this one is looking at a branch, and the
  /// session that wrote it may not be the one on screen, may be in a different
  /// worktree, and may have no tab open at all.
  const owner = createMemo(() => branchOwner(props.root, props.pr.headRef));

  const ownerTarget = createMemo<SessionTarget | null>(() => {
    const o = owner();
    if (!o) return null;
    return {
      sessionId: o.session.id,
      agent: o.session.agent ?? "claude",
      profile: o.session.profile ?? null,
      folderPath: o.folderPath,
      sessionCwd: o.session.cwd,
      sessionPath: o.session.path,
      sessionTitle: o.session.title,
      sessionFile: o.session.path,
    };
  });

  /// Who would get the thread and how they are doing, or why nobody would.
  ///
  /// One memo rather than a label beside a separate refusal, because they are
  /// the same question asked twice and a pair that could disagree is how a
  /// reason ends up printed next to a button that still works.
  ///
  /// Both refusals are about the target, never about the thread: an outdated or
  /// resolved conversation is still worth an agent's attention, and withholding
  /// it would be this panel deciding what the reader meant. The readiness is the
  /// composed session status, the same one the sidebar row shows, so the two
  /// cannot disagree about a session mid-turn. `none` is not a refusal: a
  /// session with nothing running is resumed by safe-send before it writes.
  const sendTo = createMemo<{ label: string; name: string; ready: boolean }>(() => {
    const o = owner();
    if (!o) {
      const label = `Nothing has run on ${props.pr.headRef} in this project.`;
      return { label, name: "", ready: false };
    }
    const name = o.session.name || o.session.title || o.session.id;
    // An agent the user turned off first, since that is the refusal they can
    // act on without leaving the question of what this agent can do.
    const off = agentOffReason(o.session.agent ?? "claude");
    if (off) return { label: off, name, ready: false };
    if (findAdapter(o.session.agent ?? "claude").resume_args.length === 0) {
      return { label: "This agent's sessions can't be resumed", name, ready: false };
    }
    const status = sessionStatus(o.session.id);
    const how = status === "none" ? "Not running" : STATUS_LABEL[status];
    return { label: `${name} · ${how}`, name, ready: true };
  });

  async function sendThread(t: ReviewThread) {
    const target = ownerTarget();
    const home = owner();
    if (!target || !home || !sendTo().ready) return;
    const mine = current;
    // Read before the send, not after: the owner can change while a message is
    // in flight (a newer session appears, the branch moves), and a confirmation
    // naming whoever owns it *now* would name a session that received nothing.
    const to = sendTo().name;
    setSendingThread(t.id);
    const note = (text: string, ok: boolean) => {
      if (mine === current) setSendNotes((m) => ({ ...m, [t.id]: { text, ok } }));
    };
    try {
      // The unit's own folder, not `props.root`: a worktree project's units each
      // have a checkout, and a path resolved against the panel's one would
      // mention a real file in the wrong copy of the repo.
      const text = composeThreadAsk(target, home.folderPath, props.pr.number, t);
      const result = await requestSend({ ...target, text });
      if (result.kind === "sent") note(`Sent to ${to}.`, true);
      else if (result.kind === "blocked") note(BLOCKED_REASON, false);
      else note("Couldn't reach the session, try again.", false);
    } finally {
      if (mine === current) setSendingThread(null);
    }
  }

  // --- landing it -----------------------------------------------------------

  /// Run a mutation that lands or moves the branch, and report the server's own
  /// sentence when it refuses.
  ///
  /// Its wording, verbatim, is the point: GitHub knows about branch protection
  /// Tori cannot read, so "At least 1 approving review is required" is a fact
  /// only the refusal carries. A generic "could not merge" here would throw away
  /// the only actionable thing in the whole exchange.
  async function land(run: () => Promise<void>, after: () => void) {
    const mine = current;
    setMergeBusy(true);
    setMergeError(null);
    try {
      await run();
      if (mine !== current) return;
      after();
      // The chip and the row read the server's verdict, and it has changed.
      void pollNow("manual");
    } catch (e) {
      if (mine === current) setMergeError(forgeErrorMessage(e));
    } finally {
      if (mine === current) setMergeBusy(false);
    }
  }

  const mergePr = (method: MergeMethod) =>
    land(
      () =>
        invoke<void>("forge_merge", {
          projectPath: props.root,
          number: props.pr.number,
          method,
        }),
      () => {
        setMerged(true);
        props.onLanded();
      },
    );

  const updateBranch = () =>
    land(
      () =>
        invoke<void>("forge_update_branch", {
          projectPath: props.root,
          number: props.pr.number,
        }),
      // The verdict is re-read rather than assumed: the update is queued on the
      // server (202), so `behind` may still be the current answer for a moment,
      // and guessing `clean` here would offer a merge the server refuses.
      () => void loadMergeability(props.root, props.pr.number, current),
    );

  /// The branch-unit this pull request was built on, if this machine has one.
  ///
  /// What decides whether "Delete branch" is offered at all. A pull request whose
  /// head was never checked out here has nothing local to remove, and a button
  /// that opens a dialog about a branch the sidebar does not list would be a
  /// dead end dressed as an action.
  const localUnit = createMemo(() => projectUnitFor(props.root, props.pr.headRef));

  function askToDeleteBranch() {
    const unit = localUnit();
    if (!unit) return;
    // Handed to the sidebar, which owns the guards: a dirty worktree, unpushed
    // commits, and agents still running in the folder. Deleting from here would
    // be a second path for all three to be forgotten.
    emitWith<RemoveBranchUnit>(REMOVE_BRANCH_UNIT, {
      projectPath: unit.projectPath,
      branch: props.pr.headRef,
    });
  }

  function threadCard(t: ReviewThread, quoteHunk?: boolean) {
    return (
      <ReviewThreadView
        thread={t}
        quoteHunk={quoteHunk}
        busy={busyThread() === t.id}
        onReply={(body) => void reply(t.id, body)}
        onResolve={(resolved) => void setResolved(t.id, resolved)}
        send={{
          label: sendTo().label,
          ready: sendTo().ready,
          busy: sendingThread() === t.id,
          note: sendNotes()[t.id] ?? null,
          onSend: () => void sendThread(t),
        }}
      />
    );
  }

  function fileDiff(f: PrFile) {
    const hunks = createMemo(() => parseDiffHunks(f.patch ?? ""));
    const gaps = createMemo(() => hunkGaps(hunks()));
    const skip = createMemo(() => fileSkip(f));
    // Every line this file's hunks actually render, so a thread anchored
    // outside them is held back rather than dropped.
    const rendered = createMemo(() => hunks().flatMap((h) => newSideLines(h)));
    const placed = createMemo(() =>
      splitByRenderedLines(grouped().byLine.get(f.path), rendered()),
    );
    return (
      <div class={styles.fileDiff}>
        <Show when={skip()} fallback={null}>
          {(why) => (
            <div class={styles.skip} data-file-skip={why()}>
              {SKIP_COPY[why()]}
              {/* Only the withheld patch is content the reader cannot get here.
                  A moved or binary file is complete as it stands, and offering
                  a way out of it would imply otherwise. */}
              <Show when={why() === "tooLarge"}>
                {" "}
                <a href={`${props.pr.url}/files`} target="_blank" rel="noreferrer">
                  Read it on github.com
                </a>
              </Show>
            </div>
          )}
        </Show>
        <Show when={!skip()}>
          <For each={gaps().filter((g) => g.afterHunk === -1)}>
            {(gap) => gapRow(gap, `${f.path}:-1`, f.path)}
          </For>
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
              const segments = createMemo(() => {
                // A deliberate dependency. `DiffRows` reads `selection` once
                // per row, on purpose (a surface either offers line staging or
                // it does not), so starting a review has to rebuild the rows
                // for them to become pickable. One rebuild per explicit click,
                // which is not the unrelated-render churn the memo exists to
                // stop.
                reviewing();
                return hunkSegments(rows(), lines(), placed().shown);
              });
              // The picked rows, when they are this hunk's. `DiffRows` already
              // owns line selection for the Changes panel's staging, so the
              // affordance and its keyboard handling come for free.
              const mine = createMemo(() => {
                const p = picked();
                return p && p.path === f.path && p.hunk === hi() ? p.lines : null;
              });
              const anchor = createMemo(() => {
                const sel = mine();
                if (!sel) return null;
                return anchorFor({
                  path: f.path,
                  rows: rows(),
                  newLines: lines(),
                  oldLines: oldLines(),
                  selected: [...sel],
                });
              });
              // Only while a review is under way. `DiffRows` gives every
              // selectable line a role, a tab stop and a click handler, and a
              // pull request diff runs to thousands of them: handing those out
              // to a reader who is only reading puts the whole file in the tab
              // order and makes lines respond to clicks that mean nothing.
              const selection = () =>
                reviewing()
                  ? {
                      has: (i: number) => mine()?.has(i) ?? false,
                      toggle: (i: number) => togglePick(f.path, hi(), i),
                    }
                  : undefined;
              return (
                <div>
                  <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                  <For each={segments()}>
                    {(seg) => (
                      <>
                        <DiffRows rows={seg.rows} path={f.path} twoColumn={twoColumn()} selection={selection()} />
                        <For each={seg.after}>{(t) => threadCard(t, false)}</For>
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
                          value={draftBody()}
                          onInput={(e) => setDraftBody(e.currentTarget.value)}
                          onKeyDown={(e: KeyboardEvent) => {
                            if (e.key === "Escape") setPicked(null);
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              holdComment(a());
                            }
                          }}
                        />
                        <div class={styles.composerActions}>
                          <Button variant="ghost" onClick={() => setPicked(null)}>
                            Cancel
                          </Button>
                          <Button onClick={() => holdComment(a())} disabled={!draftBody().trim()}>
                            Add to review
                          </Button>
                        </div>
                      </div>
                    )}
                  </Show>
                  <For each={gaps().filter((g) => g.afterHunk === hi())}>
                    {(gap) => gapRow(gap, `${f.path}:${hi()}`, f.path)}
                  </For>
                </div>
              );
            }}
          </For>
        </Show>

        {/* Current, correct, and on no rendered line: its anchor sits in a
            stretch the patch does not cover, or the patch was withheld. Held
            back with its quoted hunk rather than dropped, because a file that
            visibly has a conversation must not appear to have none. */}
        <Show when={placed().offDiff.length}>
          <div class={styles.threadGroup}>
            <div class={styles.groupTitle}>Not on a line this diff shows</div>
            <For each={placed().offDiff}>{(t) => threadCard(t, true)}</For>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <div class={styles.detail} ref={paneRef}>
      <div class={styles.head}>
        <Button variant="ghost" onClick={props.onBack}>
          ← Pull requests
        </Button>
        <Show when={!reviewing()}>
          <Button variant="ghost" onClick={() => setReviewOpen(true)}>
            Review
          </Button>
        </Show>
        <IconButton
          size="xs"
          active={twoColumn()}
          disabled={paneWidth() < SIDE_BY_SIDE_MIN_WIDTH}
          icon={<span aria-hidden="true">⇹</span>}
          tooltipWhenDisabled
          tooltip={
            paneWidth() < SIDE_BY_SIDE_MIN_WIDTH
              ? "Side-by-side needs a wider pane"
              : twoColumn()
                ? "Switch to inline diff"
                : "Switch to side-by-side diff"
          }
          onClick={toggleColumns}
        />
      </div>

      <div class={styles.title}>
        <span class={styles.number}>#{props.pr.number}</span>
        <span class={styles.subject}>{props.pr.title}</span>
      </div>
      <div class={styles.meta}>
        <span>{props.pr.author}</span>
        <span title={`${props.pr.headRef} into ${props.pr.baseRef}`}>
          {props.pr.headRef} → {props.pr.baseRef}
        </span>
      </div>

      {/* Above the diff, because whether this can land is the first thing a
          reader of a pull request wants to know, and it is the one control on
          the surface whose answer only the server can give. */}
      <Show when={props.pr.state === "open"}>
        <MergeBar
          state={mergeState()}
          busy={mergeBusy()}
          error={mergeError()}
          merged={merged()}
          onMerge={(method) => void mergePr(method)}
          onUpdateBranch={() => void updateBranch()}
          onDeleteBranch={localUnit() ? askToDeleteBranch : undefined}
        />
      </Show>

      <Show when={error()}>
        {(message) => <div class={styles.error}>{message()}</div>}
      </Show>
      <Show when={gapError()}>
        {(message) => <div class={styles.error}>{message()}</div>}
      </Show>
      <Show when={threadError()}>
        {(message) => <div class={styles.error}>{message()}</div>}
      </Show>

      <Show when={loading()}>
        <div class={styles.notice}>Loading files…</div>
      </Show>

      {/* GitHub's own ceiling, not a budget of ours: past it the server stops
          describing the pull request, so the honest thing is to say so and
          hand over the link rather than render a shorter list that looks whole. */}
      <Show when={truncated()}>
        <div class={styles.notice}>
          This pull request changes more files than the API will describe.{" "}
          <a href={`${props.pr.url}/files`} target="_blank" rel="noreferrer">
            See all of them on github.com
          </a>
        </div>
      </Show>

      <Show when={!loading() && !error() && files().length === 0}>
        <div class={styles.notice}>This pull request changes no files.</div>
      </Show>

      <For each={files()}>
        {(f) => (
          <div>
            <Tooltip
              as="button"
              type="button"
              class={styles.fileRow}
              label={fileLabel(f)}
              onClick={() => toggleFile(f.path)}
            >
              <span class={styles.status} data-file-status={f.status}>
                {f.status}
              </span>
              <span class={styles.path}>{fileLabel(f)}</span>
              {/* A closed file with a conversation in it is otherwise
                  indistinguishable from one with none. */}
              <Show when={threadCount(f.path)}>
                {(n) => (
                  <span class={styles.threadCount} data-thread-count={n()}>
                    {n()} 💬
                  </span>
                )}
              </Show>
              <span class={styles.counts}>
                <span class={styles.added}>+{f.additions}</span>
                <span class={styles.removed}>-{f.deletions}</span>
              </span>
            </Tooltip>
            <Show when={openFile() === f.path}>{fileDiff(f)}</Show>
          </div>
        )}
      </For>

      {/* Threads with no line to sit beside: written against a version of the
          file that has moved on. Their own group rather than a guessed line,
          because a stale remark placed on whatever occupies that line today
          reads as a remark about it (`reviewThreads.ts`). */}
      <Show when={grouped().outdated.length}>
        <div class={styles.threadGroup} data-group="outdated">
          <div class={styles.groupTitle}>
            Outdated conversations ({grouped().outdated.length})
          </div>
          <For each={grouped().outdated}>{(t) => threadCard(t, true)}</For>
        </div>
      </Show>

      <Show when={threadsTruncated()}>
        <div class={styles.notice}>
          This pull request has more conversations than one read can carry.{" "}
          <a href={props.pr.url} target="_blank" rel="noreferrer">
            See them all on github.com
          </a>
        </div>
      </Show>

      {/* Only once there is a review under way. A permanent submit bar over a
          pull request nobody is reviewing is chrome on every diff in the app,
          and the header button is the way in for a verdict that needs no words
          (an approval is a complete statement at zero characters). */}
      <Show when={reviewing()}>
        <ReviewBar
          comments={pending()}
          body={reviewBody()}
          onBody={setReviewBody}
          selfAuthored={selfAuthored()}
          capabilities={capabilities()}
          submitting={submitting()}
          onSubmit={(event) => void submitReview(event)}
          onRemove={(i) => setPending((list) => list.filter((_, at) => at !== i))}
        />
      </Show>
    </div>
  );
}
