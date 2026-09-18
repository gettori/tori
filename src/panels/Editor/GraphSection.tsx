import { createEffect, createSignal, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { GitCommitHorizontal } from "lucide-solid";

import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { gitStateFor, type LogEntry } from "../../utils/gitActions";
import { authorInitials, foldPills } from "../../utils/commitGraph";
import { compactAge } from "../../utils/compactAge";
import { syntheticId } from "../../utils/syntheticTabs";
import Tooltip from "../../components/Tooltip/Tooltip";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import CommitFiles from "./CommitFiles";
import styles from "./GraphSection.module.css";

/** Enough to see the branch you are on and where it left the trunk. The full
 *  graph is a tab, and this is the glance. */
const ROWS = 40;

/** Rows of trunk kept under the base, so the commit it points at is not the
 *  last line on the page. */
const TAIL = 8;

/** Where the page stops widening. A branch further than this off the trunk has
 *  stopped being a glance, and the graph tab is the place to read it. */
const CAP = 400;

/**
 * The commit graph, compressed to fit the right panel.
 *
 * One lane, not the real ones: at this width a multi-lane graph is four pixels
 * of line art and no room for a subject, so the lanes are the editor tab's job
 * and this keeps the part that answers "where am I" - the order, the refs, and
 * which commits have not been pushed yet.
 */
export default function GraphSection(props: {
  root: string | null;
  all?: boolean;
  /** The trunk's name, whose pill wears the trunk lane's colour. */
  base?: string | null;
}) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());

  const pills = (c: LogEntry) => foldPills(c.refs, props.base);

  function toggle(sha: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(sha)) next.add(sha);
      return next;
    });
  }

  // Keyed on HEAD rather than on a watcher burst: `.git` is watcher-filtered,
  // and the store already re-reads HEAD on every event that can move it, so a
  // commit, a pull or a checkout all arrive here as a new sha.
  createEffect(
    on(
      () => [props.root, gitStateFor(props.root).head, !!props.all] as const,
      async ([root, , all]) => {
        setOpen(new Set<string>());
        if (!root) {
          setEntries([]);
          return;
        }
        try {
          // A branch longer than one page would push the base off the bottom,
          // and where you left the trunk is the one thing this section is for.
          // So the page grows to reach it, rather than the reader paging for it.
          const offset = await invoke<number>("git_base_offset", { projectPath: root }).catch(
            () => 0,
          );
          const limit = Math.min(CAP, Math.max(ROWS, offset + TAIL));
          setEntries(await invoke<LogEntry[]>("git_log", { projectPath: root, limit, all }));
          setError("");
        } catch (e) {
          setEntries([]);
          setError(String(e));
        }
      },
    ),
  );

  return (
    <Show
      when={entries().length}
      fallback={<div class="tree-empty">{error() || "No commits yet."}</div>}
    >
      <OverlayScroll class={styles.scroll}>
        <For each={entries()}>
          {(c) => (
            <div
              class={styles.entry}
              classList={{ [styles.open]: open().has(c.sha), [styles.local]: c.off_base }}
            >
              {/* The button expands; the commit itself opens from the control
                  beside it, kept outside since a button cannot hold one. */}
              <div class={styles.rowWrap}>
                <Tooltip
                  as="button"
                  type="button"
                  class={styles.row}
                  aria-expanded={open().has(c.sha)}
                  label={`${c.short} - ${c.author}, ${c.relative_date}`}
                  onClick={() => toggle(c.sha)}
                >
                  <span class={styles.lane} aria-hidden="true">
                    <span class={styles.dot} classList={{ [styles.head]: pills(c).some((p) => p.kind === "head") }} />
                  </span>
                  <span class={styles.subject}>{c.subject}</span>
                  <For each={pills(c)}>
                    {(pill) => (
                      <span class={`${styles.ref} ${styles[pill.kind]}`} classList={{ [styles.base]: pill.base }}>
                        {pill.label}
                      </span>
                    )}
                  </For>
                  <span class={styles.who} aria-hidden="true">
                    {authorInitials(c.author)}
                  </span>
                  <span class={styles.age}>{compactAge(c.committed_at)}</span>
                </Tooltip>
                <span class={styles.rowEnd}>
                  <IconButton
                    size="xs"
                    icon={<Icon icon={GitCommitHorizontal} />}
                    tooltip="Open this commit"
                    onClick={() =>
                      props.root &&
                      emitWith(OPEN_IN_EDITOR, { path: syntheticId("commit", props.root, c.sha) })
                    }
                  />
                </span>
              </div>
              <Show when={open().has(c.sha) && props.root}>
                <CommitFiles root={props.root!} sha={c.sha} />
              </Show>
            </div>
          )}
        </For>
      </OverlayScroll>
    </Show>
  );
}
