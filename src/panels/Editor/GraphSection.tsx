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
export default function GraphSection(props: {
  root: string | null;
  all?: boolean;
  /** The trunk's name, whose pill wears the trunk lane's colour. */
  base?: string | null;
}) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());

  const isBase = (name: string) => !!props.base && (name === props.base || name === `origin/${props.base}`);

  /** One pill per branch: `x` and `origin/x` on one commit fold into `x -
   *  origin/x`, except for HEAD, whose remote the hollow dot already speaks
   *  for. A remote with no local branch keeps its own pill. */
  const pills = (c: LogEntry) => {
    const all = c.refs.map(refPill);
    const head = all.find((p) => p.kind === "head")?.label;
    const hasLocal = (name: string) => name === head || all.some((p) => p.kind === "branch" && p.label === name);
    const remoteOf = (name: string) => all.find((p) => p.kind === "remote" && p.label.endsWith(`/${name}`));
    return all.flatMap((p) => {
      if (p.kind === "remote" && hasLocal(p.label.slice(p.label.indexOf("/") + 1))) return [];
      const remote = p.kind === "branch" ? remoteOf(p.label) : undefined;
      const label = remote ? `${p.label} - ${remote.label}` : p.label;
      return [{ ...p, label, base: isBase(p.label) }];
    });
  };

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
