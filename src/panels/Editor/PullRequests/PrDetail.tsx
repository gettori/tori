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
import { groupThreads } from "../../../utils/reviewThreads";
import { isSelfAuthored } from "../../../utils/pendingReview";
import { fileLabel } from "../../../utils/prFiles";
import { projectUnitFor } from "../../../utils/sessionActivity";
import { emitWith, REMOVE_BRANCH_UNIT, type RemoveBranchUnit } from "../../../utils/events";
import { forgeCapabilities, forgeViewer, pollNow } from "../../../utils/forgeStatus";
import {
  clearDraft,
  ensure,
  prEntry,
  refresh,
  removePending,
  setReviewBody,
  setThreadsError,
  toDrafts,
} from "../../../utils/prReviewStore";
import {
  forgeErrorMessage,
  type MergeMethod,
  type PullRequest,
  type ReviewEvent,
} from "../../../utils/forgeTypes";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../../utils/sideBySide";
import PrFileBody from "./PrFileBody";
import PrThreadCard from "./PrThreadCard";
import ReviewBar from "./ReviewBar";
import MergeBar from "./MergeBar";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Tooltip from "../../../components/Tooltip/Tooltip";
import styles from "./PrDetail.module.css";

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
  // The pull request itself lives in `prReviewStore`, which owns the three
  // reads and the draft. Only what is about *this view* is held here: which
  // file is expanded, which rows are picked, which mutation is in flight.
  const entry = createMemo(() => prEntry(props.root, props.pr.number));
  const files = () => entry().files;
  const truncated = () => entry().filesTruncated;
  const loading = () => entry().filesLoading;
  const error = () => entry().filesError;
  const threadsTruncated = () => entry().threadsTruncated;
  const threadError = () => entry().threadsError;
  const pending = () => entry().pending;
  const reviewBody = () => entry().reviewBody;

  const [openFile, setOpenFile] = createSignal<string | null>(null);

  const grouped = createMemo(() => groupThreads(entry().threads));

  const [submitting, setSubmitting] = createSignal(false);
  // The review bar draws once there is a review to draw. There is no gate in
   // front of commenting any more: `PrFileBody` explains why the one that
   // existed bought nothing.
  const reviewing = () => pending().length > 0;
  const selfAuthored = createMemo(() => isSelfAuthored(props.pr, forgeViewer(props.root)));
  const capabilities = createMemo(() => forgeCapabilities(props.root));


  // Landing it. `null` is "nobody has asked yet", which is not `"unknown"`
  // ("GitHub has not decided"): one is a blank the UI must not render as a
  // verdict, the other is a verdict.
  const mergeState = () => entry().summary?.mergeableState ?? null;
  const [mergeBusy, setMergeBusy] = createSignal(false);
  const [mergeError, setMergeError] = createSignal<string | null>(null);
  const [merged, setMerged] = createSignal(false);
  const [paneWidth, setPaneWidth] = createSignal(Infinity);
  const twoColumn = () => sideBySide() && paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;

  // Which read is current. The panel reuses this component when a different PR
  // is opened, so a slow answer can land after the one that replaced it and put
  // one PR's files under another's number.
  let current = 0;

  createEffect(
    on([() => props.root, () => props.pr.number], ([root, number]) => {
      ++current;
      setOpenFile(null);
      setMergeBusy(false);
      setMergeError(null);
      setMerged(false);
      // The store owns the three reads and is idempotent per pull request, so
      // coming back to one already read costs nothing and shows it at once.
      ensure(root, number);
    }),
  );

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  function toggleColumns() {
    writeSideBySide(!sideBySide());
  }

  function toggleFile(path: string) {
    setOpenFile(openFile() === path ? null : path);
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
        comments: toDrafts(pending()),
      });
      if (mine !== current) return;
      // Only now. A failed submit has to hand the whole set back, or the
      // reader loses every comment they wrote to one refusal.
      clearDraft(props.root, props.pr.number);
      setThreadsError(props.root, props.pr.number, null);
      // The verdict the sidebar chip reads is the server's, and it has changed.
      void pollNow("manual");
      // The review's own comments open new threads, which this list has not
      // seen. Its own read, and its failure is already handled there.
      void refresh(props.root, props.pr.number, "threads");
    } catch (e) {
      if (mine !== current) return;
      setThreadsError(props.root, props.pr.number, forgeErrorMessage(e));
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
      () => void refresh(props.root, props.pr.number, "summary"),
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

  return (
    <div class={styles.detail} ref={paneRef}>
      <div class={styles.head}>
        <Button variant="ghost" onClick={props.onBack}>
          ← Pull requests
        </Button>
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
            <Show when={openFile() === f.path}>
              <PrFileBody root={props.root} pr={props.pr} file={f} twoColumn={twoColumn()} />
            </Show>
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
          <For each={grouped().outdated}>
            {(t) => <PrThreadCard root={props.root} pr={props.pr} thread={t} quoteHunk />}
          </For>
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
          onBody={(body) => setReviewBody(props.root, props.pr.number, body)}
          selfAuthored={selfAuthored()}
          capabilities={capabilities()}
          submitting={submitting()}
          onSubmit={(event) => void submitReview(event)}
          onRemove={(i) => removePending(props.root, props.pr.number, i)}
        />
      </Show>
    </div>
  );
}
