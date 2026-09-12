import { createEffect, createSignal, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { GitCommitHorizontal } from "lucide-solid";

import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { gitStateFor } from "../../utils/gitActions";
import { authorInitials, refPill } from "../../utils/commitGraph";
import { compactAge } from "../../utils/compactAge";
import { syntheticId } from "../../utils/syntheticTabs";
import Tooltip from "../../components/Tooltip/Tooltip";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import CommitFiles from "./CommitFiles";
import type { LogEntry } from "./CommitLog";
import styles from "./GraphSection.module.css";

/** Enough to see the branch you are on and where it left the trunk. The full
 *  graph is a tab, and this is the glance. */
const ROWS = 40;

/**
 * The commit graph, compressed to fit the right panel.
 *
 * One lane, not the real ones: at this width a multi-lane graph is four pixels
 * of line art and no room for a subject, so the lanes are the editor tab's job
 * and this keeps the part that answers "where am I" - the order, the refs, and
 * which commits have not been pushed yet.
 */
export default function GraphSection(props: { root: string | null; all?: boolean }) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());

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
          setEntries(await invoke<LogEntry[]>("git_log", { projectPath: root, limit: ROWS, all }));
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
              classList={{ [styles.open]: open().has(c.sha), [styles.local]: c.unpushed }}
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
                    <span class={styles.dot} classList={{ [styles.unpushed]: c.unpushed }} />
                  </span>
                  <span class={styles.subject}>{c.subject}</span>
                  <For each={c.refs}>
                    {(ref) => {
                      const pill = refPill(ref);
                      return <span class={`${styles.ref} ${styles[pill.kind]}`}>{pill.label}</span>;
                    }}
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
