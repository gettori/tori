import { createSignal, createEffect, on, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CaseSensitive, Ellipsis, EyeOff, Regex, WholeWord, type LucideIcon } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { debounce } from "../../utils/debounce";
import {
  DEFAULT_SEARCH_OPTIONS,
  countOccurrences,
  grepArgs,
  isUnsupported,
  splitHighlights,
  truncationNotice,
  unsupportedReason,
  type SearchOptions,
  type Submatch,
  type ToggleKey,
} from "../../utils/searchOptions";
import styles from "./SearchPanel.module.css";

// `submatches` are UTF-16 code-unit offsets into `text`, so they can index the
// string directly; the backend converts from its own byte offsets.
type SearchMatch = { path: string; line: number; text: string; submatches: Submatch[] };
type FileDigest = { path: string; digest: string };
type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  /** Which backend ran: `rg`, `git` or `plain`. */
  backend: string;
  /** Option names this backend cannot honour, so a toggle never sits inert. */
  unsupported: string[];
  files: FileDigest[];
};
type FileGroup = { path: string; matches: SearchMatch[] };
/** What the backend can do here, kept apart from `result` so clearing results
 *  (an empty query, a root switch) does not also blank the toggle states. */
type Capabilities = { backend: string; unsupported: string[] };

const MAX_RESULTS = 500;
const EMPTY_RESULT: SearchResult = {
  matches: [],
  truncated: false,
  backend: "",
  unsupported: [],
  files: [],
};
const INPUT_DEBOUNCE_MS = 200;
const FS_CHANGE_DEBOUNCE_MS = 400;

const GLOBS_ID = "search-globs";
const TOGGLES: { key: ToggleKey; icon: LucideIcon; label: string }[] = [
  { key: "case", icon: CaseSensitive, label: "Match case" },
  { key: "wholeWord", icon: WholeWord, label: "Match whole word" },
  { key: "regex", icon: Regex, label: "Use regular expression" },
  { key: "noIgnore", icon: EyeOff, label: "Search ignored files" },
];

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
 *  runs while the mode is hidden.
 *
 *  All match semantics live in the backend's one canonical regex; this panel
 *  only collects the options and renders the spans it is handed. */
export default function SearchPanel(props: { root: string | null; focusNonce: number }) {
  const [query, setQuery] = createSignal("");
  const [options, setOptions] = createSignal<SearchOptions>({ ...DEFAULT_SEARCH_OPTIONS });
  const [showGlobs, setShowGlobs] = createSignal(false);
  const [result, setResult] = createSignal<SearchResult>(EMPTY_RESULT);
  const [caps, setCaps] = createSignal<Capabilities>({ backend: "", unsupported: [] });
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inputEl: HTMLInputElement | undefined;
  // Bumped per call, so a slower in-flight request (e.g. an fs-refresh racing
  // a fresh keystroke search) can't overwrite a newer result once it resolves.
  let searchGen = 0;
  // The capability probe needs its own latest-wins guard: switching projects
  // fires one per root, and the earlier root's probe can resolve last.
  let probeGen = 0;

  /** `user` searches come from a query, toggle or glob change; `refresh` ones
   *  from the fs watcher. Only the former clears results on failure. */
  async function runSearch(q: string, source: "user" | "refresh" = "user") {
    const root = props.root;
    if (!root || !q) {
      searchGen++;
      setResult(EMPTY_RESULT);
      setError(null);
      return;
    }
    const gen = ++searchGen;
    setLoading(true);
    try {
      const r = await invoke<SearchResult>(
        "grep_project",
        grepArgs(root, q, options(), MAX_RESULTS),
      );
      if (gen !== searchGen) return;
      setResult(r);
      setCaps({ backend: r.backend, unsupported: r.unsupported });
      setError(null);
    } catch (e) {
      if (gen !== searchGen) return;
      // A failed *user* search clears the results: an invalid regex is the
      // common case, and leaving the previous pattern's hits under the error
      // reads as though they matched the pattern being complained about. A
      // failed refresh keeps them, since the results on screen are still the
      // honest answer for the query the user actually typed.
      if (source === "user") setResult(EMPTY_RESULT);
      setError(String(e));
    } finally {
      if (gen === searchGen) setLoading(false);
    }
  }

  /** Ask the backend what it can do before the first query, so a toggle it
   *  cannot honour is disabled from the start rather than after a search. An
   *  empty query returns capabilities without searching anything. */
  async function probeCapabilities() {
    const root = props.root;
    probeGen++;
    if (!root) return setCaps({ backend: "", unsupported: [] });
    const gen = probeGen;
    try {
      const r = await invoke<SearchResult>("grep_project", grepArgs(root, "", options(), 0));
      if (gen !== probeGen) return;
      setCaps({ backend: r.backend, unsupported: r.unsupported });
    } catch {
      // A failed probe must not disable controls; leave them enabled and let a
      // real search report the error.
    }
  }

  const debouncedSearch = debounce((q: string) => void runSearch(q), INPUT_DEBOUNCE_MS);
  const debouncedRefresh = debounce(() => void runSearch(query(), "refresh"), FS_CHANGE_DEBOUNCE_MS);
  const debouncedGlobs = debounce(() => void runSearch(query()), INPUT_DEBOUNCE_MS);

  function onInput(v: string) {
    setQuery(v);
    debouncedSearch(v);
  }

  // A toggle click is one deliberate act, not a keystroke, so it re-searches
  // immediately instead of waiting out the input debounce.
  function toggleOption(key: ToggleKey) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
    void runSearch(query());
  }

  function setGlob(key: "include" | "exclude", v: string) {
    setOptions((o) => ({ ...o, [key]: v }));
    debouncedGlobs();
  }

  createEffect(
    on(
      () => props.root,
      () => {
        setResult(EMPTY_RESULT);
        setError(null);
        void probeCapabilities();
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
  const notice = () =>
    truncationNotice(result().truncated, MAX_RESULTS, countOccurrences(result().matches));

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
        <div class={styles.toggleRow}>
          <For each={TOGGLES}>
            {(t) => {
              const off = () => isUnsupported(caps().unsupported, t.key);
              return (
                <IconButton
                  size="xs"
                  icon={<Icon icon={t.icon} size={14} />}
                  active={options()[t.key]}
                  disabled={off()}
                  aria-label={t.label}
                  title={off() ? `${t.label}. ${unsupportedReason(t.key, caps().backend)}` : t.label}
                  onClick={() => toggleOption(t.key)}
                />
              );
            }}
          </For>
          <span class={styles.toggleSpacer} />
          <IconButton
            size="xs"
            icon={<Icon icon={Ellipsis} size={14} />}
            active={showGlobs()}
            aria-label="Include and exclude globs"
            title="Include and exclude globs"
            // It is both a toggle button (pressed) and a disclosure for the
            // glob row (expanded); `aria-expanded` is what names the region.
            aria-expanded={showGlobs()}
            aria-controls={GLOBS_ID}
            onClick={() => setShowGlobs((v) => !v)}
          />
        </div>
        <Show when={showGlobs()}>
          <div class={styles.globRow} id={GLOBS_ID}>
            <input
              class={styles.globInput}
              type="text"
              aria-label="Include files matching these globs"
              placeholder="Include, e.g. src/**/*.ts"
              value={options().include}
              onInput={(e) => setGlob("include", e.currentTarget.value)}
            />
            <input
              class={styles.globInput}
              type="text"
              aria-label="Exclude files matching these globs"
              placeholder="Exclude, e.g. **/*.test.ts"
              value={options().exclude}
              onInput={(e) => setGlob("exclude", e.currentTarget.value)}
            />
          </div>
        </Show>
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
      <Show when={notice()}>
        <div class={styles.truncatedNotice}>{notice()}</div>
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
                    <span class={styles.matchText}>
                      <For each={splitHighlights(m.text, m.submatches)}>
                        {(seg) =>
                          seg.hit ? <mark class={styles.hit}>{seg.text}</mark> : <>{seg.text}</>
                        }
                      </For>
                    </span>
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
