import { createEffect, createMemo, createSignal, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-solid";

import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { gitStateFor } from "../../utils/gitActions";
import { authorInitials, buildGraph, refPill, type GraphRow } from "../../utils/commitGraph";
import { diffTabId, syntheticId } from "../../utils/syntheticTabs";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import Button from "../../components/Button/Button";
import type { LogEntry } from "./CommitLog";
import styles from "./GraphView.module.css";

/** One backend page. The list grows by this much per "Load more". */
const PAGE = 100;

/** One commit's changed files, as `git_commit_detail` reports them. */
type CommitFile = { path: string; old_path: string | null; status: string };
type CommitDetail = { files: CommitFile[] };

/** Lane geometry in design px, before `--ui-scale`. */
const LANE_W = 14;
const ROW_H = 24;
const DOT_R = 4;

/** Lanes cycle through six of the scale hues, the same set the file icons draw
 *  from. Written out rather than built from a lane number, so every token the
 *  drawing names is one the token check can see. */
const LANE_HUES = [
  "var(--scale-blue)",
  "var(--scale-orange)",
  "var(--scale-green)",
  "var(--scale-purple)",
  "var(--scale-pink)",
  "var(--scale-yellow)",
];
const laneHue = (lane: number) => LANE_HUES[lane % LANE_HUES.length];

/**
 * The commit graph, at reading width.
 *
 * The sidebar's Graph section is the glance: one lane, the subject, the refs.
 * This is the other half, and it is a tab for the reason the commit log is one
 * - lanes, author, date and sha are four columns, and the right panel is the
 * narrow column. Expanding a row lists what that commit touched, so the
 * question "what landed here" is answered without leaving the graph.
 */
export default function GraphView(props: { workspace: string }) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [files, setFiles] = createSignal<Record<string, CommitFile[]>>({});

  const graph = createMemo(() => buildGraph(entries()));

  async function load(skip: number) {
    if (loading()) return;
    setLoading(true);
    try {
      const page = await invoke<LogEntry[]>("git_log", {
        projectPath: props.workspace,
        skip,
        limit: PAGE,
      });
      setEntries((prev) => (skip ? [...prev, ...page] : page));
      setDone(page.length < PAGE);
      setError("");
    } catch (e) {
      setError(String(e));
      if (!skip) setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  // Reloaded from the top whenever HEAD moves, for `GraphSection`'s reason:
  // `.git` is watcher-filtered, and the store re-reads HEAD on every event that
  // can move it. Paging state resets with it, since the rows below page one
  // describe a history that just changed shape.
  createEffect(
    on(
      () => [props.workspace, gitStateFor(props.workspace).head] as const,
      () => {
        setOpen(new Set<string>());
        setFiles({});
        setDone(false);
        void load(0);
      },
    ),
  );

  /** Expand a row, fetching its file list once. */
  async function toggle(sha: string) {
    const now = open();
    if (now.has(sha)) {
      const next = new Set(now);
      next.delete(sha);
      setOpen(next);
      return;
    }
    if (!files()[sha]) {
      try {
        const detail = await invoke<CommitDetail>("git_commit_detail", {
          projectPath: props.workspace,
          sha,
        });
        setFiles((prev) => ({ ...prev, [sha]: detail.files }));
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    setOpen((prev) => new Set(prev).add(sha));
  }

  /** One row's lane art. An SVG per row rather than one over the whole list:
   *  rows expand, so a single tall drawing would have to be re-laid out on
   *  every toggle instead of flowing with them. */
  function lanes(row: GraphRow) {
    const width = () => Math.max(1, graph().width) * LANE_W;
    const x = (lane: number) => lane * LANE_W + LANE_W / 2;
    return (
      <svg
        class={styles.lanes}
        style={{ width: `calc(${width()}px * var(--ui-scale))` }}
        viewBox={`0 0 ${width()} ${ROW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <For each={row.edges}>
          {(edge) => (
            <path
              d={
                edge.from === edge.to
                  ? `M ${x(edge.from)} 0 L ${x(edge.to)} ${ROW_H}`
                  : // A bend meets the dot at the row's middle, so a merge
                    // reads as joining this commit rather than crossing it.
                    `M ${x(edge.from)} 0 C ${x(edge.from)} ${ROW_H / 2}, ${x(edge.to)} ${ROW_H / 2}, ${x(edge.to)} ${ROW_H}`
              }
              fill="none"
              stroke={laneHue(Math.max(edge.from, edge.to))}
              stroke-width="1.5"
            />
          )}
        </For>
        <circle
          cx={x(row.lane)}
          cy={ROW_H / 2}
          r={DOT_R}
          fill={row.entry.unpushed || row.merge ? "var(--canvas-default)" : laneHue(row.lane)}
          stroke={laneHue(row.lane)}
          stroke-width="2"
        />
      </svg>
    );
  }

  return (
    <div class={styles.graphView}>
      <div class={styles.topBar}>
        <span class={styles.title}>Graph</span>
        <Show when={gitStateFor(props.workspace).branch}>
          {(branch) => <span class={styles.branch}>{branch()}</span>}
        </Show>
        <span class={styles.spacer} />
        <span class={styles.count}>{entries().length} loaded</span>
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          aria-label="Refresh"
          tooltip="Re-read the graph"
          onClick={() => void load(0)}
        />
      </div>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
      <Show
        when={entries().length}
        fallback={<Show when={!loading()}><div class="tree-empty">No commits yet.</div></Show>}
      >
        <OverlayScroll class={styles.scroll}>
          <For each={graph().rows}>
            {(row) => (
              <div>
                <div class={styles.row}>
                  <button
                    type="button"
                    class={styles.twist}
                    aria-expanded={open().has(row.entry.sha)}
                    aria-label={open().has(row.entry.sha) ? "Hide files" : "Show files"}
                    onClick={() => void toggle(row.entry.sha)}
                  >
                    <Icon icon={open().has(row.entry.sha) ? ChevronDown : ChevronRight} />
                  </button>
                  {lanes(row)}
                  <span class={styles.subject} title={row.entry.subject}>
                    {row.entry.subject}
                  </span>
                  <For each={row.entry.refs}>
                    {(ref) => {
                      const pill = refPill(ref);
                      return <span class={`${styles.ref} ${styles[pill.kind]}`}>{pill.label}</span>;
                    }}
                  </For>
                  <span class={styles.who} title={row.entry.author}>
                    {authorInitials(row.entry.author)}
                  </span>
                  <span class={styles.author}>{row.entry.author}</span>
                  <span class={styles.when}>{row.entry.relative_date}</span>
                  <button
                    type="button"
                    class={styles.sha}
                    title="Open this commit"
                    onClick={() =>
                      emitWith(OPEN_IN_EDITOR, {
                        path: syntheticId("commit", props.workspace, row.entry.sha),
                      })
                    }
                  >
                    {row.entry.short}
                  </button>
                </div>
                <Show when={open().has(row.entry.sha)}>
                  <div class={styles.files}>
                    <Show
                      when={files()[row.entry.sha]?.length}
                      fallback={<div class={styles.noFiles}>No files in this commit.</div>}
                    >
                      <For each={files()[row.entry.sha]}>
                        {(f) => (
                          <button
                            type="button"
                            class={styles.fileRow}
                            title={f.path}
                            // The working-tree diff, not this commit's: the tab
                            // kind shows a file against the index or HEAD, and
                            // a historical diff is the commit view's own.
                            onClick={() =>
                              emitWith(OPEN_IN_EDITOR, {
                                path: diffTabId(props.workspace, f.path, false),
                              })
                            }
                          >
                            <span class={styles.fileStatus} data-status={f.status}>
                              {f.status}
                            </span>
                            <span class={styles.filePath}>{f.path}</span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={!done()}>
            <div class={styles.more}>
              <Button size="sm" variant="ghost" disabled={loading()} onClick={() => void load(entries().length)}>
                {loading() ? "Loading" : "Load more"}
              </Button>
            </div>
          </Show>
        </OverlayScroll>
      </Show>
    </div>
  );
}
