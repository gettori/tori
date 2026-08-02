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
import { buildRows, hunkGaps, type Gap } from "../../../utils/diffView";
import { fileSkip, fileLabel, type FileSkip } from "../../../utils/prFiles";
import { forgeErrorMessage, type Paged, type PrFile, type PullRequest } from "../../../utils/forgeTypes";
import { readSideBySide, writeSideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "../../../utils/sideBySide";
import DiffRows, { diffRowClasses } from "../DiffRows";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import styles from "./PrDetail.module.css";

/** The sentence for each reason a file shows no diff. Three situations arrive
 *  as the same `patch: null`, and only one of them means something is missing;
 *  see `prFiles.ts` for how they are told apart. */
const SKIP_COPY: Record<FileSkip, string> = {
  tooLarge: "This file's diff is larger than the API will send.",
  moved: "Moved, with no change to its contents.",
  noText: "No line changes to show (a binary file, or a mode change).",
};

export default function PrDetail(props: { root: string; pr: PullRequest; onBack: () => void }) {
  const [files, setFiles] = createSignal<PrFile[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [openGaps, setOpenGaps] = createSignal<ReadonlySet<string>>(new Set());
  const [gapLines, setGapLines] = createSignal<Record<string, string[]>>({});
  const [gapError, setGapError] = createSignal<string | null>(null);

  const [sideBySide, setSideBySide] = createSignal(readSideBySide());
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

  createEffect(
    on([() => props.root, () => props.pr.number], async ([root, number]) => {
      const mine = ++current;
      setOpenFile(null);
      setOpenGaps(new Set<string>());
      setGapLines({});
      setGapError(null);
      headFetch = null;
      setLoading(true);
      setError(null);
      try {
        const page = await invoke<Paged<PrFile>>("github_pr_files", {
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
    }),
  );

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
    const next = !sideBySide();
    setSideBySide(next);
    writeSideBySide(next);
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

  function fileDiff(f: PrFile) {
    const hunks = createMemo(() => parseDiffHunks(f.patch ?? ""));
    const gaps = createMemo(() => hunkGaps(hunks()));
    const skip = createMemo(() => fileSkip(f));
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
            {(hunk, hi) => (
              <div>
                <div class={`${diffRowClasses.line} ${diffRowClasses.hunk}`}>{hunk.header}</div>
                <DiffRows rows={buildRows(hunk.lines)} twoColumn={twoColumn()} />
                <For each={gaps().filter((g) => g.afterHunk === hi())}>
                  {(gap) => gapRow(gap, `${f.path}:${hi()}`, f.path)}
                </For>
              </div>
            )}
          </For>
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
        <IconButton
          size="xs"
          active={twoColumn()}
          disabled={paneWidth() < SIDE_BY_SIDE_MIN_WIDTH}
          icon={<span aria-hidden="true">⇹</span>}
          title={
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

      <Show when={error()}>
        {(message) => <div class={styles.error}>{message()}</div>}
      </Show>
      <Show when={gapError()}>
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
            <button
              type="button"
              class={styles.fileRow}
              title={fileLabel(f)}
              onClick={() => toggleFile(f.path)}
            >
              <span class={styles.status} data-file-status={f.status}>
                {f.status}
              </span>
              <span class={styles.path}>{fileLabel(f)}</span>
              <span class={styles.counts}>
                <span class={styles.added}>+{f.additions}</span>
                <span class={styles.removed}>-{f.deletions}</span>
              </span>
            </button>
            <Show when={openFile() === f.path}>{fileDiff(f)}</Show>
          </div>
        )}
      </For>
    </div>
  );
}
