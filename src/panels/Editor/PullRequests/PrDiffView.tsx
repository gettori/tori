// One file of a pull request, as a tab in the stage.
//
// The panel's column is 320px and a diff is not a 320px document. This is the
// same file the panel lists, opened where there is room to read it: the header
// says which file and where it sits in the pull request, and `PrFileBody` below
// draws the hunks and the conversations.
//
// It fetches nothing. `ensure` on mount and every read comes from
// `prReviewStore`, so nine files open at once are one `forge_pr_files` call and
// a tab that opens after the read has landed shows its diff immediately.

import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { ArrowDown, Columns2, ExternalLink, FileCode } from "lucide-solid";
import { emitWith, OPEN_IN_EDITOR } from "../../../utils/events";
import { parsePrDiffArg, prDiffTabId } from "../../../utils/syntheticTabs";
import { sideBySideOn as sideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../../utils/sideBySide";
import { projectUnitFor } from "../../../utils/sessionActivity";
import { unitStatusForPr } from "../../../utils/forgeStatus";
import { ensure, headDrift, isViewed, prEntry, refresh, setViewedFile } from "../../../utils/prReviewStore";
import PrFileBody from "./PrFileBody";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import styles from "./PrDiffView.module.css";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export default function PrDiffView(props: { workspace: string; arg: string }) {
  const target = createMemo(() => parsePrDiffArg(props.arg));
  const [paneWidth, setPaneWidth] = createSignal(Infinity);

  const entry = createMemo(() => prEntry(props.workspace, target().number));
  /// The pull request itself, from the poll where it covered this branch and
  /// from whoever opened the tab where it did not.
  ///
  /// The poll first, because it is the fresher of the two and every chip on
  /// screen is already reading it; a second request per open tab would be a
  /// read for a fact the app is displaying. The store's copy is the fallback
  /// that keeps a pull request on a branch this machine has no unit for from
  /// rendering as no pull request at all: its opener calls `notePr`.
  const pr = createMemo(
    () => unitStatusForPr(props.workspace, target().number)?.pullRequest ?? entry().pr,
  );
  const files = () => entry().files;
  const file = createMemo(() => files().find((f) => f.path === target().file) ?? null);
  const at = createMemo(() => files().findIndex((f) => f.path === target().file));
  const next = createMemo(() => files()[at() + 1] ?? null);
  const drifted = () => headDrift(props.workspace, target().number);
  const wide = () => paneWidth() >= SIDE_BY_SIDE_MIN_WIDTH;
  const twoColumn = () => sideBySide() && wide();

  /// This file's outdated conversations, which the tab has nowhere else to put.
  ///
  /// The panel keeps a pull-request-wide group at its foot; a tab is one file,
  /// so an outdated thread here either goes in the strip or disappears.
  const outdated = createMemo(() =>
    entry().threads.filter((t) => t.path === target().file && (t.line === null || t.isOutdated)),
  );

  /// The branch-unit this pull request was built on, if this machine has one.
  ///
  /// What decides whether opening the real file is offered at all. A pull
  /// request whose head was never checked out here has no such file, and a
  /// button that opens an editor on a path that does not exist is a dead end
  /// dressed as an action.
  const localUnit = createMemo(() => (pr() ? projectUnitFor(props.workspace, pr()!.headRef) : null));

  createEffect(on([() => props.workspace, () => target().number], ([root, number]) => ensure(root, number)));

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class={styles.prDiff} ref={paneRef}>
      <div class={styles.topBar}>
        <Show when={file()}>
          {(f) => (
            <>
              {/* The row's accessible name already says what changed, so the
                  letter is decoration. */}
              <span class={styles.status} data-file-status={f().status} aria-hidden="true">
                {f().status.slice(0, 1).toUpperCase()}
              </span>
              <span class={styles.name}>{fileName(f().path)}</span>
              <Show when={fileDir(f().path)}>
                <span class={styles.dir}>{fileDir(f().path)}</span>
              </Show>
              <span class={styles.counts}>
                <span class={styles.added}>+{f().additions}</span>
                <span class={styles.removed}>-{f().deletions}</span>
              </span>
            </>
          )}
        </Show>
        <Show when={at() >= 0}>
          <span class={styles.position}>
            file {at() + 1} of {files().length}
          </span>
        </Show>
        <span class={styles.spacer} />

        <label class={styles.viewed}>
          <input
            type="checkbox"
            checked={isViewed(props.workspace, target().number, target().file)}
            onChange={(e) =>
              setViewedFile(props.workspace, target().number, target().file, e.currentTarget.checked)
            }
          />
          Viewed
        </label>

        <IconButton
          size="sm"
          aria-pressed={twoColumn()}
          icon={<Icon icon={Columns2} />}
          disabled={!wide()}
          tooltipWhenDisabled
          tooltip={
            !wide()
              ? "Side-by-side needs a wider pane"
              : twoColumn()
                ? "Switch to inline diff"
                : "Switch to side-by-side diff"
          }
          onClick={() => writeSideBySide(!sideBySide())}
        />
        {/* Only where the branch is checked out here. Everywhere else the head
            is a commit in the object store and there is no file to open. */}
        <Show when={localUnit()}>
          {(unit) => (
            <IconButton
              size="sm"
              icon={<Icon icon={FileCode} />}
              tooltip="Open the file in this worktree"
              onClick={() =>
                emitWith(OPEN_IN_EDITOR, { path: `${unit().folderPath}/${target().file}` })
              }
            />
          )}
        </Show>
        <Show when={pr()}>
          {(p) => (
            <IconButton
              size="sm"
              icon={<Icon icon={ExternalLink} />}
              tooltip={`Open pull request ${p().number} on github.com`}
              onClick={() => window.open(`${p().url}/files`, "_blank", "noreferrer")}
            />
          )}
        </Show>
        <Show when={next()}>
          {(n) => (
            <IconButton
              size="sm"
              icon={<Icon icon={ArrowDown} />}
              tooltip="Next file in pull request"
              onClick={() =>
                emitWith(OPEN_IN_EDITOR, {
                  path: prDiffTabId(props.workspace, target().number, n().path),
                })
              }
            />
          )}
        </Show>
      </div>

      {/* The head has moved since these patches were read, so every anchor
          below describes a file the server no longer has. Said out loud and
          offered a reload rather than silently re-fetching: a diff that
          rearranges itself under a reader mid-sentence is worse than a stale
          one that admits it. */}
      <Show when={drifted()}>
        <div class={styles.drift}>
          <span>This pull request has new commits since you read this.</span>
          <Button
            variant="ghost"
            onClick={() => void refresh(props.workspace, target().number, "files")}
          >
            Reload the diff
          </Button>
        </div>
      </Show>

      <Show when={entry().filesError}>
        {(message) => <div class={styles.error}>{message()}</div>}
      </Show>

      <Show
        when={pr() && file()}
        fallback={
          <div class="tree-empty">
            <Show when={!entry().filesLoading && !entry().filesError}>
              <p>
                {pr()
                  ? "This file is not in the pull request's diff any more."
                  : "No pull request here carries that number."}
              </p>
            </Show>
          </div>
        }
      >
        <div class={styles.body}>
          <PrFileBody
            root={props.workspace}
            pr={pr()!}
            file={file()!}
            twoColumn={twoColumn()}
            outdated={outdated()}
          />
        </div>
      </Show>
    </div>
  );
}
