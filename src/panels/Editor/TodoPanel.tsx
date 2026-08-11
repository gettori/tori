import { createEffect, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { debounce } from "../../utils/debounce";
import { composeTodo, requestSend, type SessionTarget } from "../../utils/safeSend";
import { todoBlocks } from "../../utils/chatCompose";
import { sendBlockedReason, sendTargetFor } from "../../utils/sendTarget";
import { grepArgs, DEFAULT_SEARCH_OPTIONS } from "../../utils/searchOptions";
import {
  filterByTags,
  groupTodos,
  tagCounts,
  todoItems,
  todoQuery,
  todoSummary,
  todoTags,
  type TodoItem,
  type TodoMatch,
} from "../../utils/todoScan";
import { editorDefaults } from "../Settings/settingsStore";
import Button from "../../components/Button/Button";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import styles from "./TodoPanel.module.css";

type GrepResult = { matches: TodoMatch[]; truncated: boolean };

const MAX_RESULTS = 500;
const FS_CHANGE_DEBOUNCE_MS = 400;

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Every TODO, FIXME and whatever else this project calls them, over the whole
 * repo.
 *
 * One `grep_project` for an alternation of the configured tags rather than a
 * search per tag, and the tags come from the three-layer settings resolution
 * (`editorDefaults().todoPatterns`), so a repo that says `NOTE` and `REVIEW`
 * in its `.sway/settings.json` gets those instead of somebody else's.
 *
 * Refreshes on `fs://changed` while mounted, on its own longer debounce, the
 * way the Search panel does: the right-hand Switch/Match tears this component
 * down when another mode is selected, so no background grep runs while it is
 * hidden.
 */
export default function TodoPanel(props: { root: string | null; selected: Selection | null }) {
  const [items, setItems] = createSignal<TodoItem[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedTags, setSelectedTags] = createSignal<ReadonlySet<string>>(new Set());
  // Bumped per call so a slow fs-refresh cannot overwrite a newer scan, the
  // same latest-wins guard the Search panel keeps.
  let scanGen = 0;

  const tags = () => todoTags(editorDefaults().todoPatterns);
  const shown = () => filterByTags(items(), selectedTags());
  const groups = () => groupTodos(shown());
  const counts = () => tagCounts(items(), tags());

  async function scan() {
    const root = props.root;
    const list = tags();
    if (!root || !list.length) {
      scanGen++;
      setItems([]);
      setTruncated(false);
      setError(null);
      return;
    }
    const gen = ++scanGen;
    setLoading(true);
    try {
      // Case-sensitive: a `TODO` marker and the word "todo" in a sentence are
      // different things, and a panel listing every prose mention of "hack" is
      // one nobody reads twice.
      const options = { ...DEFAULT_SEARCH_OPTIONS, regex: true, case: true };
      const r = await invoke<GrepResult>(
        "grep_project",
        grepArgs(root, todoQuery(list), options, MAX_RESULTS),
      );
      if (gen !== scanGen) return;
      setItems(todoItems(r.matches));
      setTruncated(r.truncated);
      setError(null);
    } catch (e) {
      if (gen !== scanGen) return;
      setItems([]);
      setError(String(e));
    } finally {
      if (gen === scanGen) setLoading(false);
    }
  }

  const debouncedScan = debounce(() => void scan(), FS_CHANGE_DEBOUNCE_MS);

  // Re-scans when the project changes and when the tags do, which is what makes
  // editing the setting visible without reopening the panel. `tags()` reads the
  // resolved value, so a workspace override re-scans exactly as a user-level
  // edit does.
  createEffect(
    on([() => props.root, () => editorDefaults().todoPatterns], () => {
      // A tag that is no longer configured must not go on filtering the list
      // from a chip that is no longer on screen.
      setSelectedTags(new Set<string>());
      void scan();
    }),
  );

  let unlistenFs: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen("fs://changed", () => debouncedScan());
  });
  onCleanup(() => unlistenFs?.());

  function toggleTag(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });
  }

  /** Through `OPEN_IN_EDITOR` rather than a direct open: that event is the one
   *  place arrivals are recorded, so a TODO is worth exactly one jump-list
   *  entry and Back returns to wherever you were. */
  function jumpTo(item: TodoItem) {
    const root = props.root;
    if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${item.path}`, line: item.line });
  }

  // The same capability gate the Problems and Debug panels use: safe-send needs
  // a resumable session to land the text in.
  function target(): SessionTarget | null {
    const answer = sendTargetFor(props.selected);
    return "target" in answer ? answer.target : null;
  }

  function disabledReason(): string | null {
    return sendBlockedReason(props.selected);
  }

  async function sendToAgent(item: TodoItem) {
    const root = props.root;
    const t = target();
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!t || !root) return;
    const abs = `${root}/${item.path}`;
    // Insert-only and never auto-submitted, per the safe-send contract: the
    // text lands at the prompt and the user presses Enter.
    const result = await requestSend({
      ...t,
      text: composeTodo(t, abs, item.line, item.tag, item.text),
      blocks: todoBlocks(abs, item.line, item.tag, item.text),
    });
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, {
        message: "That session is waiting on a prompt, answer it first.",
        kind: "error",
      });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
    }
  }

  return (
    <div class={styles.todoPanel}>
      <Show
        when={tags().length}
        fallback={
          <div class="tree-empty">
            No TODO tags configured. Set them in Settings under “TODO tags”.
          </div>
        }
      >
        <div class={styles.tagRow}>
          <For each={tags()}>
            {(tag) => (
              <button
                type="button"
                class={`${styles.chip} ${selectedTags().has(tag) ? styles.chipOn : ""}`}
                aria-pressed={selectedTags().has(tag)}
                title={`Show only ${tag}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
                <span class={styles.chipCount}>{counts()[tag] ?? 0}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={!error() && items().length}>
          <div class={styles.summary}>
            {todoSummary(shown(), groups().length, truncated(), MAX_RESULTS)}
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="tree-empty">{error()}</div>
      </Show>
      {/* "Nothing tagged" is a claim about a project, so it must not be made
          when there is no project to have searched. */}
      <Show when={!error() && tags().length && !props.root}>
        <div class="tree-empty">Open a project to see its TODOs.</div>
      </Show>
      <Show when={!error() && tags().length && props.root && !loading() && !items().length}>
        <div class="tree-empty">Nothing tagged in this project.</div>
      </Show>
      <div class={styles.results}>
        <For each={groups()}>
          {(group) => (
            <div class={styles.fileGroup}>
              <div class={styles.fileHead} title={group.path}>
                <span class={styles.fileName}>{basename(group.path)}</span>
                <span class={styles.count}>{group.items.length}</span>
              </div>
              <For each={group.items}>
                {(item) => (
                  <div class={styles.todoRow} onClick={() => jumpTo(item)} title={item.text}>
                    <span class={styles.tag}>{item.tag}</span>
                    <span class={styles.loc}>{item.line}</span>
                    <span class={styles.text}>{item.text}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      class={styles.sendButton}
                      title={disabledReason() ?? "Send to agent"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void sendToAgent(item);
                      }}
                    >
                      Send
                    </Button>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
