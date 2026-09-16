import { createEffect, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR, TOAST, type FsChanged, type ToastEvent } from "../../utils/events";
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
import { memberSectionsHeaded, type MemberRoot } from "../../utils/featureMembers";
import { editorDefaults } from "../Settings/settingsStore";
import Button from "../../components/Button/Button";
import MemberSection from "../../components/MemberSection/MemberSection";
import Tooltip from "../../components/Tooltip/Tooltip";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import styles from "./TodoPanel.module.css";

type GrepResult = { matches: TodoMatch[]; truncated: boolean };

/** One root's worth of scan. Per root rather than one merged list, because a
 *  cap and a failure are both facts about the repo they happened in: a monorepo
 *  member hitting the cap must not make the small one next to it read as
 *  truncated too. */
type TodoSection = { root: string; items: TodoItem[]; truncated: boolean; error?: string };

const MAX_RESULTS = 500;
const FS_CHANGE_DEBOUNCE_MS = 400;

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Every TODO, FIXME and whatever else this project calls them, over the whole
 * repo, or over every member of a Feature at once.
 *
 * One `grep_project` for an alternation of the configured tags rather than a
 * search per tag, and the tags come from the three-layer settings resolution
 * (`editorDefaults().todoPatterns`), so a repo that says `NOTE` and `REVIEW`
 * in its `.tori/settings.json` gets those instead of somebody else's.
 *
 * Inside a Feature that becomes one grep per member, run together and kept
 * apart: the backend caps each one, so merging them into a single list would
 * let a member full of TODOs report a cap the others never hit. A member that
 * fails reports in its own section rather than blanking the panel, the same way
 * the Search panel's legs do.
 *
 * Refreshes on `fs://changed` while mounted, on its own longer debounce, the
 * way the Search panel does: the right-hand Switch/Match tears this component
 * down when another mode is selected, so no background grep runs while it is
 * hidden.
 */
export default function TodoPanel(props: {
  root: string | null;
  selected: Selection | null;
  /** The multi-root form, one section per Feature member. A branch unit passes
   *  none and is scanned as its own single root. */
  roots?: MemberRoot[];
}) {
  const [sections, setSections] = createSignal<TodoSection[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [selectedTags, setSelectedTags] = createSignal<ReadonlySet<string>>(new Set());
  // Bumped per call so a slow fs-refresh cannot overwrite a newer scan, the
  // same latest-wins guard the Search panel keeps.
  let scanGen = 0;

  /** Every root the panel draws a section for, unusable members included: a
   *  member with no worktree still needs somewhere to say so. */
  const scanRoots = (): MemberRoot[] => {
    if (props.roots) return props.roots;
    return props.root ? [{ path: props.root, repoPath: props.root, label: "" }] : [];
  };
  /** The roots a scan actually greps. A member with no worktree has none: its
   *  section path is the repo folder, and grepping that would search a checkout
   *  this Feature is not on. */
  const searchRoots = () => scanRoots().filter((r) => r.state?.usable !== false);
  const headed = () => memberSectionsHeaded(props.roots);
  // The identity of the set, so the rescan effect fires when the members change
  // and not when the array is merely rebuilt. NUL because no path contains one.
  const rootsKey = () => searchRoots().map((r) => r.path).join("\u0000");

  const tags = () => todoTags(editorDefaults().todoPatterns);
  const sectionOf = (root: string) => sections().find((s) => s.root === root);
  const items = () => sections().flatMap((s) => s.items);
  const shownPerRoot = () => sections().map((s) => filterByTags(s.items, selectedTags()));
  const shown = () => shownPerRoot().flat();
  // Counted per root and summed, not over the merged list: a hit's path is
  // relative to the repo it was found in, so two members with a `src/a.ts` are
  // two files on screen and merging them would report one.
  const shownFiles = () => shownPerRoot().reduce((n, list) => n + groupTodos(list).length, 0);
  const counts = () => tagCounts(items(), tags());
  const anyError = () => sections().some((s) => s.error);
  /** The summary claims a cap only when there is one section to claim it for.
   *  Alongside others the cap belongs to the member that hit it, and each says
   *  so in its own header row. */
  const summaryTruncated = () => !headed() && sections().some((s) => s.truncated);

  async function grepRoot(root: string, list: string[]): Promise<TodoSection> {
    // Case-sensitive: a `TODO` marker and the word "todo" in a sentence are
    // different things, and a panel listing every prose mention of "hack" is
    // one nobody reads twice.
    const options = { ...DEFAULT_SEARCH_OPTIONS, regex: true, case: true };
    try {
      const r = await invoke<GrepResult>(
        "grep_project",
        grepArgs(root, todoQuery(list), options, MAX_RESULTS),
      );
      return { root, items: todoItems(r.matches), truncated: r.truncated };
    } catch (e) {
      return { root, items: [], truncated: false, error: String(e) };
    }
  }

  async function scan() {
    const roots = searchRoots();
    const list = tags();
    if (!roots.length || !list.length) {
      scanGen++;
      setSections([]);
      return;
    }
    const gen = ++scanGen;
    setLoading(true);
    try {
      const legs = await Promise.all(roots.map((r) => grepRoot(r.path, list)));
      if (gen !== scanGen) return;
      setSections(legs);
    } finally {
      if (gen === scanGen) setLoading(false);
    }
  }

  /** Re-grep just the roots the watcher named, leaving the other sections as
   *  they are: a change in one member must not blank the member beside it while
   *  a fresh scan is in flight. */
  async function refreshRoots(roots: string[]) {
    const list = tags();
    if (!roots.length || !list.length) return;
    const gen = scanGen;
    const legs = await Promise.all(roots.map((r) => grepRoot(r, list)));
    // A full rescan started meanwhile wins: it is the newer answer, and these
    // legs were greps of the set it replaced.
    if (gen !== scanGen) return;
    setSections((prev) => prev.map((s) => legs.find((l) => l.root === s.root) ?? s));
  }

  const dirtyRoots = new Set<string>();
  const flushDirty = debounce(() => {
    // Re-checked against the live set: a member can leave the Feature inside the
    // debounce window, and grepping a root nothing draws is wasted work whose
    // answer is dropped on the way back in.
    const here = new Set(searchRoots().map((r) => r.path));
    const roots = [...dirtyRoots].filter((r) => here.has(r));
    dirtyRoots.clear();
    void refreshRoots(roots);
  }, FS_CHANGE_DEBOUNCE_MS);

  // Re-scans when the member set changes and when the tags do, which is what
  // makes editing the setting visible without reopening the panel. `tags()`
  // reads the resolved value, so a workspace override re-scans exactly as a
  // user-level edit does.
  createEffect(
    on([rootsKey, () => editorDefaults().todoPatterns], () => {
      // A tag that is no longer configured must not go on filtering the list
      // from a chip that is no longer on screen.
      setSelectedTags(new Set<string>());
      void scan();
    }),
  );

  let unlistenFs: UnlistenFn | undefined;
  onMount(async () => {
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      const named = e.payload.root;
      const roots = searchRoots().map((r) => r.path);
      // An untagged burst is about all of them; a tagged one about exactly one,
      // and one this panel may not be scanning at all.
      const hit = named ? roots.filter((r) => r === named) : roots;
      if (!hit.length) return;
      for (const r of hit) dirtyRoots.add(r);
      flushDirty();
    });
  });
  onCleanup(() => {
    flushDirty.cancel();
    unlistenFs?.();
  });

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
  function jumpTo(root: string, item: TodoItem) {
    emitWith(OPEN_IN_EDITOR, { path: `${root}/${item.path}`, line: item.line });
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

  async function sendToAgent(root: string, item: TodoItem) {
    const t = target();
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!t) return;
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
              <Tooltip
                as="button"
                type="button"
                class={`${styles.chip} ${selectedTags().has(tag) ? styles.chipOn : ""}`}
                aria-pressed={selectedTags().has(tag)}
                label={`Show only ${tag}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
                <span class={styles.chipCount}>{counts()[tag] ?? 0}</span>
              </Tooltip>
            )}
          </For>
        </div>
        {/* Not gated on a failure any more: with several members, one repo's
            grep exploding says nothing about the hits the others returned. */}
        <Show when={items().length}>
          <div class={styles.summary}>
            {todoSummary(shown(), shownFiles(), summaryTruncated(), MAX_RESULTS)}
          </div>
        </Show>
      </Show>
      {/* "Nothing tagged" is a claim about a project, so it must not be made
          when there is no project to have searched. */}
      <Show when={tags().length && !scanRoots().length}>
        <div class="tree-empty">Open a project to see its TODOs.</div>
      </Show>
      <Show when={!anyError() && tags().length && scanRoots().length && !loading() && !items().length}>
        <div class="tree-empty">Nothing tagged in this project.</div>
      </Show>
      <div class={styles.results}>
        <For each={scanRoots()}>
          {(member) => {
            const found = () => sectionOf(member.path);
            const groups = () => groupTodos(filterByTags(found()?.items ?? [], selectedTags()));
            return (
              <MemberSection root={member} headed={headed()} count={found()?.items.length}>
                <Show when={found()?.error}>
                  <div class="tree-empty">{found()!.error}</div>
                </Show>
                {/* The cap belongs to the repo that hit it, so it is said here
                    rather than in the summary above, which is the whole
                    Feature's count. */}
                <Show when={headed() && found()?.truncated}>
                  <div class={styles.summary}>
                    Capped at {MAX_RESULTS}, narrow the tags to see the rest.
                  </div>
                </Show>
                <For each={groups()}>
                  {(group) => (
                    <div class={styles.fileGroup}>
                      <div class={styles.fileHead} title={group.path}>
                        <span class={styles.fileName}>{basename(group.path)}</span>
                        <span class={styles.count}>{group.items.length}</span>
                      </div>
                      <For each={group.items}>
                        {(item) => (
                          <div
                            class={styles.todoRow}
                            onClick={() => jumpTo(member.path, item)}
                            title={item.text}
                          >
                            <span class={styles.tag}>{item.tag}</span>
                            <span class={styles.loc}>{item.line}</span>
                            <span class={styles.text}>{item.text}</span>
                            <Button
                              size="xs"
                              variant="ghost"
                              class={styles.sendButton}
                              tooltip={disabledReason() ?? "Send to agent"}
                              onClick={(e) => {
                                e.stopPropagation();
                                void sendToAgent(member.path, item);
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
              </MemberSection>
            );
          }}
        </For>
      </div>
    </div>
  );
}
