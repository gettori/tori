import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { debounce } from "../../utils/debounce";
import styles from "./SearchPanel.module.css";

type SearchMatch = { path: string; line: number; text: string };
type SearchResult = { matches: SearchMatch[]; truncated: boolean };
type FileGroup = { path: string; matches: SearchMatch[] };

const MAX_RESULTS = 500;
const INPUT_DEBOUNCE_MS = 200;
const FS_CHANGE_DEBOUNCE_MS = 400;

// Groups matches by file, preserving the order files were first seen in.
function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    if (!byPath.has(m.path)) {
      order.push(m.path);
      byPath.set(m.path, []);
    }
    byPath.get(m.path)!.push(m);
  }
  return order.map((path) => ({ path, matches: byPath.get(path)! }));
}

/** Project-wide Search mode: debounced query -> `grep_project`, results
 *  grouped by file with per-file match counts, click opens the file at the
 *  matched line. Refreshes on `fs://changed` (its own, longer debounce) only
 *  while this mode is mounted - the Editor's right-panel Switch/Match tears
 *  the component down when another mode is selected, so no background grep
 *  runs while the mode is hidden. */
export default function SearchPanel(props: { root: string | null; focusNonce: number }) {
  const [query, setQuery] = createSignal("");
  const [result, setResult] = createSignal<SearchResult>({ matches: [], truncated: false });
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inputEl: HTMLInputElement | undefined;
  // Bumped per call, so a slower in-flight request (e.g. an fs-refresh racing
  // a fresh keystroke search) can't overwrite a newer result once it resolves.
  let searchGen = 0;

  async function runSearch(q: string) {
    const root = props.root;
    if (!root || !q) {
      searchGen++;
      setResult({ matches: [], truncated: false });
      setError(null);
      return;
    }
    const gen = ++searchGen;
    setLoading(true);
    try {
      const r = await invoke<SearchResult>("grep_project", { root, query: q, case: false, max: MAX_RESULTS });
      if (gen !== searchGen) return;
      setResult(r);
      setError(null);
    } catch (e) {
      if (gen !== searchGen) return;
      setError(String(e));
    } finally {
      if (gen === searchGen) setLoading(false);
    }
  }

  const debouncedSearch = debounce((q: string) => void runSearch(q), INPUT_DEBOUNCE_MS);
  const debouncedRefresh = debounce(() => void runSearch(query()), FS_CHANGE_DEBOUNCE_MS);

  function onInput(v: string) {
    setQuery(v);
    debouncedSearch(v);
  }

  createEffect(
    on(
      () => props.root,
      () => {
        setResult({ matches: [], truncated: false });
        setError(null);
      },
    ),
  );

  createEffect(
    on(
      () => props.focusNonce,
      (_n, prev) => {
        // Deferred to the next frame: Cmd+Shift+F can reveal the editor + right
        // panel on the same event, and a synchronous focus would hit the panel
        // while it is still display:none and be dropped.
        if (prev !== undefined) requestAnimationFrame(() => inputEl?.focus());
      },
    ),
  );

  function openMatch(path: string, line: number) {
    const root = props.root;
    if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${path}`, line });
  }

  let unlistenFs: UnlistenFn | undefined;
  onMount(() => {
    inputEl?.focus();
  });
  onMount(async () => {
    unlistenFs = await listen("fs://changed", () => {
      if (query()) debouncedRefresh();
    });
  });
  onCleanup(() => {
    unlistenFs?.();
  });

  const groups = () => groupByFile(result().matches);

  return (
    <div class={styles.searchPanel}>
      <div class={styles.inputBar}>
        <input
          ref={inputEl}
          class={styles.searchInput}
          type="text"
          placeholder="Search project"
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>
      <Show when={error()}>
        <div class="tree-empty">{error()}</div>
      </Show>
      <Show when={!error() && !query()}>
        <div class="tree-empty">Type to search the project</div>
      </Show>
      <Show when={!error() && query() && !loading() && !result().matches.length}>
        <div class="tree-empty">No matches</div>
      </Show>
      <Show when={result().truncated}>
        <div class={styles.truncatedNotice}>Showing the first {MAX_RESULTS} matches</div>
      </Show>
      <div class={styles.results}>
        <For each={groups()}>
          {(group) => (
            <div class={styles.fileGroup}>
              <div class={styles.fileHeader} title={group.path}>
                <span class={styles.filePath}>{group.path}</span>
                <span class={styles.matchCount}>{group.matches.length}</span>
              </div>
              <For each={group.matches}>
                {(m) => (
                  <div class={styles.matchRow} onClick={() => openMatch(m.path, m.line)}>
                    <span class={styles.matchLine}>{m.line}</span>
                    <span class={styles.matchText}>{m.text}</span>
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
