import {
  createSignal,
  createEffect,
  createMemo,
  on,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CaseSensitive,
  Ellipsis,
  EyeOff,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { debounce } from "../../utils/debounce";
import {
  DEFAULT_SEARCH_OPTIONS,
  countOccurrences,
  dirtyRelativePaths,
  grepArgs,
  isUnsupported,
  replaceOutcome,
  replaceTargets,
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
type ReplaceOutcome = { changed: string[]; skipped: { path: string; reason: string }[]; occurrences: number };
/** One span to replace, as `replace_in_files` takes it. */
type ReplaceSpan = { line: number; start: number; end: number };

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
 *  only collects the options and renders the spans it is handed. Replace is the
 *  same story: the preview text comes from the backend, because reproducing
 *  `$1` expansion in JavaScript's regex dialect could show something the write
 *  would not produce. */
export default function SearchPanel(props: {
  root: string | null;
  focusNonce: number;
  /** Absolute-keyed dirty record from the editor. Files with unsaved edits are
   *  left out of a replace: the buffer, not the disk, is what the user sees. */
  dirty?: Record<string, boolean>;
  /** Editor's `askConfirm`. It is local to that component rather than exported,
   *  so it arrives as a prop; without one, Replace All proceeds unconfirmed. */
  confirm?: (opts: { title: string; message?: string; confirmLabel?: string }) => Promise<boolean>;
}) {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [showReplace, setShowReplace] = createSignal(false);
  const [options, setOptions] = createSignal<SearchOptions>({ ...DEFAULT_SEARCH_OPTIONS });
  const [showGlobs, setShowGlobs] = createSignal(false);
  const [result, setResult] = createSignal<SearchResult>(EMPTY_RESULT);
  const [caps, setCaps] = createSignal<Capabilities>({ backend: "", unsupported: [] });
  const [preview, setPreview] = createSignal<(string | null)[]>([]);
  const [outcome, setOutcome] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
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

  // --- replace ---

  /** Flat list of every displayed span, in render order, so a preview response
   *  can be read back positionally. */
  const flatSpans = () =>
    result().matches.flatMap((m) => m.submatches.map(([start, end]) => ({ text: m.text, start, end })));

  /** Where each match's spans begin within `flatSpans()`. Memoised because the
   *  alternative is rescanning the result set once per rendered span, which is
   *  quadratic at the 500-line cap. */
  const previewBase = createMemo(() => {
    const base = new Map<SearchMatch, number>();
    let i = 0;
    for (const m of result().matches) {
      base.set(m, i);
      i += m.submatches.length;
    }
    return base;
  });

  /** Index of a given match's Nth span within `flatSpans()`, so a row can find
   *  its own preview entry. */
  function previewIndex(match: SearchMatch, spanIndex: number): number {
    const base = previewBase().get(match);
    return base === undefined ? -1 : base + spanIndex;
  }

  let previewGen = 0;
  async function runPreview() {
    const spans = flatSpans();
    if (!replacement() || !spans.length) return setPreview([]);
    const gen = ++previewGen;
    try {
      const out = await invoke<(string | null)[]>("preview_replace", {
        query: query(),
        options: options(),
        replacement: replacement(),
        spans,
      });
      if (gen === previewGen) setPreview(out);
    } catch {
      // An unpreviewable replacement (a bad pattern) simply shows no preview;
      // the search error slot already carries the reason.
      if (gen === previewGen) setPreview([]);
    }
  }
  const debouncedPreview = debounce(() => void runPreview(), INPUT_DEBOUNCE_MS);

  const dirtyPaths = () => dirtyRelativePaths(props.root ?? "", props.dirty ?? {});
  const allTargets = () => replaceTargets(result().matches, result().files, dirtyPaths());

  /** Apply `targets`, then report and re-search. The re-search matters beyond
   *  freshness: it is what proves on screen that the write landed. */
  async function applyReplace(
    targets: { path: string; digest: string; matches: ReplaceSpan[] }[],
    skippedForDirt: string[] = [],
  ) {
    const root = props.root;
    // One replace at a time. A second would find every digest already moved and
    // report "0 replaced, N skipped (changed on disk)" for work that in fact
    // succeeded, which reads as a failure.
    if (!root || !targets.length || applying()) return;
    setApplying(true);
    try {
      const out = await invoke<ReplaceOutcome>("replace_in_files", {
        root,
        query: query(),
        options: options(),
        replacement: replacement(),
        targets,
      });
      // Deliberately NOT markSelfWrite: the buffers of open files do not hold
      // this edit, so suppressing the watcher echo would leave a clean tab
      // showing pre-replace text whose next save would silently revert it.
      const skipped = [
        ...out.skipped,
        ...skippedForDirt.map((path) => ({ path, reason: "unsaved changes" })),
      ];
      setOutcome(replaceOutcome(out.occurrences, out.changed, skipped));
      setError(null);
      await runSearch(query());
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  async function replaceAll() {
    const targets = allTargets();
    if (!targets.length || applying()) return;
    const occurrences = targets.reduce((n, t) => n + t.matches.length, 0);
    const files = targets.length;
    const ok = props.confirm
      ? await props.confirm({
          title: `Replace ${occurrences} ${occurrences === 1 ? "occurrence" : "occurrences"} in ${files} ${files === 1 ? "file" : "files"}?`,
          message: "This writes to disk and cannot be undone from here.",
          confirmLabel: "Replace",
        })
      : true;
    if (!ok) return;
    await applyReplace(targets, dirtyPaths().filter((p) => result().matches.some((m) => m.path === p)));
  }

  function replaceFile(path: string) {
    void applyReplace(allTargets().filter((t) => t.path === path));
  }

  function replaceOne(m: SearchMatch, span: Submatch) {
    const target = allTargets().find((t) => t.path === m.path);
    if (!target) return;
    void applyReplace([
      { ...target, matches: [{ line: m.line, start: span[0], end: span[1] }] },
    ]);
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

  // Re-preview when the replacement text changes, a new result set arrives, or
  // the replace row is reopened. Debounced, so typing a replacement does not
  // fire a round trip per keystroke. `showReplace` has to be a dependency and
  // not just a read: reopening the row after the results changed underneath it
  // would otherwise show no preview until the replacement was retyped.
  createEffect(
    on([replacement, result, showReplace], () => {
      if (showReplace()) debouncedPreview();
      else setPreview([]);
    }),
  );

  // A replace outcome describes one past action. Anything that changes what is
  // on screen retires it, so a success line can never sit above results it had
  // nothing to do with.
  createEffect(
    on(
      [query, options, () => props.root],
      () => setOutcome(null),
      { defer: true },
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
        <Show when={showReplace()}>
          <div class={styles.replaceRow}>
            <input
              class={styles.searchInput}
              type="text"
              aria-label="Replace with"
              placeholder="Replace with"
              value={replacement()}
              onInput={(e) => setReplacement(e.currentTarget.value)}
            />
            <IconButton
              size="xs"
              icon={<Icon icon={ReplaceAll} size={14} />}
              aria-label="Replace all"
              title={
                result().truncated
                  ? "Refine the search first: Replace All is disabled while results are capped"
                  : "Replace all"
              }
              // A capped result set is a subset of the real matches, so a
              // "replace everything" that silently means "replace the first 500"
              // is the one action that must not be offered here.
              disabled={result().truncated || !allTargets().length || applying()}
              onClick={() => void replaceAll()}
            />
          </div>
        </Show>
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
            icon={<Icon icon={Replace} size={14} />}
            active={showReplace()}
            aria-label="Toggle replace"
            title="Toggle replace"
            aria-expanded={showReplace()}
            onClick={() => setShowReplace((v) => !v)}
          />
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
      <Show when={outcome()}>
        <div class={styles.outcome}>{outcome()}</div>
      </Show>
      <div class={styles.results}>
        <For each={groups()}>
          {(group) => (
            <div class={styles.fileGroup}>
              <div class={styles.fileHeader} title={group.path}>
                <span class={styles.filePath}>{group.path}</span>
                <span class={styles.matchCount}>{group.matches.length}</span>
                <Show when={showReplace() && replacement()}>
                  <IconButton
                    size="xs"
                    class={styles.rowAction}
                    icon={<Icon icon={Replace} size={12} />}
                    aria-label={`Replace in ${group.path}`}
                    title={`Replace in ${group.path}`}
                    disabled={dirtyPaths().includes(group.path) || applying()}
                    onClick={() => replaceFile(group.path)}
                  />
                </Show>
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
                    <Show when={showReplace() && replacement()}>
                      <span class={styles.previewText}>
                        <For each={m.submatches}>
                          {(span, i) => {
                            const next = () => preview()[previewIndex(m, i())];
                            return (
                              <Show when={next() != null}>
                                <span class={styles.previewPair}>
                                  <del class={styles.previewOld}>
                                    {m.text.slice(span[0], span[1])}
                                  </del>
                                  <ins class={styles.previewNew}>{next()}</ins>
                                  <IconButton
                                    size="xs"
                                    class={styles.rowAction}
                                    icon={<Icon icon={Replace} size={12} />}
                                    aria-label={`Replace this occurrence on line ${m.line}`}
                                    title="Replace this occurrence"
                                    disabled={dirtyPaths().includes(m.path) || applying()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      replaceOne(m, span);
                                    }}
                                  />
                                </span>
                              </Show>
                            );
                          }}
                        </For>
                      </span>
                    </Show>
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
