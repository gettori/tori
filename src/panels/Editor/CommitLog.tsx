import { createSignal, createMemo, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { gitStateFor } from "../../utils/gitActions";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { syntheticId } from "../../utils/syntheticTabs";
import IconButton from "../../components/IconButton/IconButton";
import Button from "../../components/Button/Button";
import Tooltip from "../../components/Tooltip/Tooltip";
import Icon from "../../components/Icon/Icon";
import { RefreshCw } from "lucide-solid";
import styles from "./CommitLog.module.css";

/** Mirrors `LogEntry` in src-tauri/src/git.rs. */
export type LogEntry = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  relative_date: string;
  refs: string[];
  /** Full parent shas: one ordinarily, several for a merge, none for a root. */
  parents: string[];
  /** On HEAD but not on its upstream. */
  unpushed: boolean;
};

/** One backend page. The list grows by this much per "Load more". */
const PAGE = 100;

/**
 * A commit log, as an editor tab rather than a panel: history is read at reading
 * width, and the right panel is already the narrow column.
 *
 * With `file` set it is that one file's history instead of the branch's. One
 * component rather than two, because the difference is a pathspec and a header:
 * splitting them would give a reader two places to look for the same rows and
 * two chances for them to drift.
 *
 * Its workspace comes from the tab id, not from the current selection, so the
 * tab always shows the branch-unit it was opened for. The header's branch and
 * ahead/behind come from the shared git store, which is only the same thing
 * while that unit is selected - and since tabs are per-workspace, it is.
 */
export default function CommitLog(props: { workspace: string; file?: string }) {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [end, setEnd] = createSignal(false);
  const [error, setError] = createSignal("");

  // This workspace's own slot: a log tab open on a background member still
  // wants that member's branch, not whichever member is in front.
  const meta = () => gitStateFor(props.workspace);
  // Memos, not plain accessors. The reload effect below reads these, and a
  // plain accessor would make it depend on the *store signal*, which every file
  // save bumps (`refreshStatus` rewrites `files`) - so the log would refetch on
  // every watcher burst. A memo only propagates when its own value changes.
  const branch = createMemo(() => meta().branch);
  const aheadBehind = createMemo(() => meta().aheadBehind);

  // Which load is current. A reload *replaces* the list, so a newer one simply
  // supersedes an older one in flight; refusing to start it (the obvious guard)
  // would silently drop the reload a commit landing mid-fetch asks for, and
  // leave the log stale until the next thing moved HEAD.
  let current = 0;

  async function load(more: boolean) {
    // "Load more" is the one call that must not overlap: two of them would page
    // from the same offset and append the same commits twice.
    if (more && loading()) return;
    const mine = ++current;
    setLoading(true);
    const skip = more ? entries().length : 0;
    try {
      const result = await invoke<LogEntry[]>("git_log", {
        projectPath: props.workspace,
        skip,
        limit: PAGE,
        file: props.file,
      });
      if (mine !== current) return;
      // Anything but a list is treated as an empty page rather than indexed
      // into: this renders during a workspace switch, and a `null` from a
      // command that has gone away would otherwise take the pane down with it.
      const page = Array.isArray(result) ? result : [];
      setError("");
      setEnd(page.length < PAGE);
      setEntries(more ? [...entries(), ...page] : page);
    } catch (e) {
      if (mine !== current) return;
      setError(String(e));
      if (!more) setEntries([]);
    } finally {
      // The superseded load leaves the flag to whoever replaced it.
      if (mine === current) setLoading(false);
    }
  }

  // Reloaded whenever the store re-reads this workspace's branch metadata, which
  // is exactly the set of things that move HEAD: a commit, a push, a fetch, a
  // checkout. A file save re-reads the *status* only, and leaves this alone.
  createEffect(on([() => props.workspace, () => props.file, branch, aheadBehind], () => void load(false)));

  function openCommit(sha: string) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: syntheticId("commit", props.workspace, sha) });
  }

  return (
    <div class={styles.commitLog}>
      <div class={styles.headerBar}>
        <Show
          when={props.file}
          fallback={
            <>
              <span class={styles.branchName} title={branch() ?? ""}>
                {branch() ?? "Commit log"}
              </span>
              <Show when={aheadBehind()} fallback={<span class={styles.meta}>-</span>}>
                {(ab) => (
                  <span class={styles.meta}>
                    {ab().has_upstream ? `↑${ab().ahead} ↓${ab().behind}` : "Unpushed branch"}
                  </span>
                )}
              </Show>
            </>
          }
        >
          {(f) => (
            <>
              <span class={styles.branchName} title={f()}>
                {f()}
              </span>
              {/* Said out loud because it changes what the list means: rows from
                  before a rename name a path this file no longer has. */}
              <span class={styles.meta}>following renames</span>
            </>
          )}
        </Show>
        <IconButton
          size="xs"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Reload the log"
          disabled={loading()}
          onClick={() => void load(false)}
        />
      </div>
      <Show when={error()}>
        <div class={styles.error}>{error()}</div>
      </Show>
      <Show
        when={entries().length}
        fallback={
          <Show when={!loading() && !error()}>
            <div class="tree-empty">{props.file ? "No commits touch this file." : "No commits yet."}</div>
          </Show>
        }
      >
        <For each={entries()}>
          {(c) => (
            <Tooltip as="button" type="button" class={styles.row} label={c.sha} onClick={() => openCommit(c.sha)}>
              <span class={styles.sha}>{c.short}</span>
              <span class={styles.subject}>{c.subject}</span>
              <For each={c.refs}>{(r) => <span class={styles.ref}>{r}</span>}</For>
              <span class={styles.author}>{c.author}</span>
              <span class={styles.date}>{c.relative_date}</span>
            </Tooltip>
          )}
        </For>
        <Show when={!end()}>
          <div class={styles.moreRow}>
            <Button size="xs" disabled={loading()} onClick={() => void load(true)}>
              {loading() ? "Loading…" : "Load more"}
            </Button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
