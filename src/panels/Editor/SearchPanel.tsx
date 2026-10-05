import { createSignal, createEffect, createMemo, on, onMount, onCleanup, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CaseUpper,
  ChevronsDownUp,
  ChevronsUpDown,
  FilePlus2,
  List,
  ListTree,
  Pencil,
  RefreshCw,
  Replace,
  ReplaceAll,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-solid";
import Button from "../../components/Button/Button";
import Chevron from "../../components/Chevron/Chevron";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
import FileIcon from "../../seti/FileIcon";
import {
  emitWith,
  onWith,
  OPEN_IN_EDITOR,
  PURGE_WORKSPACE,
  SET_RIGHT_MODE,
  type FsChanged,
  type OpenInEditor,
  type PurgeWorkspace,
  type SetRightMode,
} from "../../utils/events";
import { dropWorkspaceKey } from "../../utils/purgeWorkspace";
import { debounce } from "../../utils/debounce";
import { copyText } from "../../utils/clipboard";
import {
  DEFAULT_SEARCH_OPTIONS,
  countOccurrences,
  dirtyRelativePaths,
  grepArgs,
  mergeSearchResults,
  openUnder,
  previewSegments,
  replaceOutcome,
  replaceTargets,
  truncationNotice,
  unionUnsupported,
  type RootOutcome,
  type SearchMatch,
  type SearchOptions,
  type SearchResult,
  type SearchSection,
  type ToggleKey,
} from "../../utils/searchOptions";
import {
  baseName,
  dirName,
  filesUnder,
  folderPaths,
  folderTree,
  groupByFile,
  type FileGroup,
  type FolderNode,
} from "../../utils/pathTree";
import MemberChip from "../../components/MemberChip/MemberChip";
import { type MemberRoot, type TintedMember } from "../../utils/topicMembers";
import {
  DRAFT,
  historyFor,
  loadSearchHistory,
  noteQuery,
  recallAt,
  saveSearchHistory,
  stepRecall,
  type SearchHistoryStore,
} from "../../utils/searchHistory";
import {
  deleteSearch,
  loadSavedSearches,
  nameTaken,
  renameSearch,
  saveSavedSearches,
  saveSearch,
  savedFor,
  type SavedSearch,
  type SavedSearchStore,
} from "../../utils/savedSearches";
import { DEFAULT_CONTEXT_LINES, openSearchEditor } from "./searchResultsStore";
import { grepRoot, MAX_RESULTS } from "./searchRun";
import { Field, GlobFields, InlineToggle, MatchToggles } from "./SearchFields";
import tree from "./FileTree/FileTree.module.css";
import styles from "./SearchPanel.module.css";

/** What the backends can do here, kept apart from `sections` so clearing results
 *  (an empty query, a workspace switch) does not also blank the toggle states.
 *  Unioned across members: a toggle one member cannot honour is disabled for
 *  all of them, since its result set would be a lie for that member. */
type Capabilities = { backend: string; unsupported: string[] };
type ReplaceOutcome = { changed: string[]; skipped: { path: string; reason: string }[]; occurrences: number };
/** One span to replace, as `replace_in_files` takes it. */
type ReplaceSpan = { line: number; start: number; end: number };

const INPUT_DEBOUNCE_MS = 200;
const FS_CHANGE_DEBOUNCE_MS = 400;

/** The separator every root-set key is joined on. A path may contain a space,
 *  and two different member sets must never spell the same key. Named rather
 *  than inlined because a raw NUL in a source file is invisible: one that
 *  reached a template literal here type-checked and passed every test. */
const NUL = "\u0000";

const GLOBS_ID = "search-globs";
const SAVED_ID = "search-saved";
const QUERY_HINT_ID = "search-query-hint";
const VIEW_KEY = "tori.search.view.v1";

const fileKey = (root: string, path: string) => `${root}${NUL}${path}`;
const matchKey = (root: string, m: SearchMatch) => `${root}${NUL}${m.path}${NUL}${m.line}`;
const folderKey = (root: string, path: string) => `${root}${NUL}${path}/`;
const memberKey = (root: string) => `${root}${NUL}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A hover action at a row's right edge. It stops the click, since the row
 *  under it has a click of its own. */
function RowAction(props: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <InlineToggle
      icon={props.icon}
      label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    />
  );
}

/** Project-wide Search mode, VS Code's Search view: debounced query ->
 *  `grep_project`, results grouped by member and then by file (or by folder,
 *  as a tree), click opens the file at the matched line. Inside a Topic every
 *  member is searched at once: `grep_project` stays single-root and this panel
 *  fans out and merges, because the sections, the per-member truncation and the
 *  per-member replace targets have to exist here whatever the backend returns.
 *  Refreshes on `fs://changed` (its own, longer debounce) only while this mode
 *  is mounted - the Editor's right-panel Switch/Match tears the component down
 *  when another mode is selected, so no background grep runs while the mode is
 *  hidden.
 *
 *  All match semantics live in the backend's one canonical regex; this panel
 *  only collects the options and renders the spans it is handed. Replace is the
 *  same story: the preview text comes from the backend, because reproducing
 *  `$1` expansion in JavaScript's regex dialect could show something the write
 *  would not produce. */
export default function SearchPanel(props: {
  root: string | null;
  /** The multi-root form, one section per Topic member. A branch unit passes
   *  none and the panel searches `root` alone, headerless, exactly as it did. */
  roots?: MemberRoot[];
  /** The same members with their chip colours, for the member toggles. */
  members?: readonly TintedMember[];
  /** The store key history and saved searches live under; defaults to `root`. */
  workspace?: string;
  focusNonce: number;
  /** Find in Folder: one repo and one folder in it, applied once on arrival. */
  scope?: { repoPath: string; rel: string; nonce: number } | null;
  onScoped?: () => void;
  /** Absolute-keyed dirty record from the editor. Files with unsaved edits are
   *  left out of a replace: the buffer, not the disk, is what the user sees. */
  dirty?: Record<string, boolean>;
  /** Absolute paths of the files open in editor tabs. */
  openPaths?: readonly string[];
  /** Editor's `askConfirm`. It is local to that component rather than exported,
   *  so it arrives as a prop; without one, Replace All proceeds unconfirmed. */
  confirm?: (opts: { title: string; message?: string; confirmLabel?: string }) => Promise<boolean>;
}) {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [showReplace, setShowReplace] = createSignal(false);
  const [preserveCase, setPreserveCase] = createSignal(false);
  const [options, setOptions] = createSignal<SearchOptions>({ ...DEFAULT_SEARCH_OPTIONS });
  const [openOnly, setOpenOnly] = createSignal(false);
  const [showGlobs, setShowGlobs] = createSignal(false);
  const [asTree, setAsTree] = createSignal(localStorage.getItem(VIEW_KEY) === "tree");
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  /** One entry per searched root, in member order. Empty until a search runs. */
  const [sections, setSections] = createSignal<SearchSection[]>([]);
  const [caps, setCaps] = createSignal<Capabilities>({ backend: "", unsupported: [] });
  const [preview, setPreview] = createSignal<(string | null)[]>([]);
  const [outcome, setOutcome] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Both stores are read and written only here, so they load on mount and write
  // through on every change rather than living in the Editor: this panel is torn
  // down whenever another right-hand mode is picked, and re-reading them is what
  // makes that survivable.
  const [history, setHistory] = createSignal<SearchHistoryStore>(loadSearchHistory());
  const [saved, setSaved] = createSignal<SavedSearchStore>(loadSavedSearches());
  onCleanup(
    onWith<PurgeWorkspace>(PURGE_WORKSPACE, ({ workspace }) => {
      setHistory((s) => dropWorkspaceKey(s, workspace));
      setSaved((s) => dropWorkspaceKey(s, workspace));
    }),
  );
  const [cursor, setCursor] = createSignal(DRAFT);
  const [showSaved, setShowSaved] = createSignal(false);
  const [saveName, setSaveName] = createSignal("");
  const [renaming, setRenaming] = createSignal<string | null>(null);
  /** Why a rename was refused. Its own line inside the saved-searches row, not
   *  the `error` slot: that one is where a failed *search* reports, and a naming
   *  complaint sitting above the results reads as though the hits below it were
   *  the ones that went wrong. */
  const [savedNotice, setSavedNotice] = createSignal<string | null>(null);
  let inputEl: HTMLInputElement | undefined;
  /** What was in the box when recall started, restored by arrowing back down
   *  past the newest entry. The options and the restriction travel with it:
   *  recall replaces all three, so returning only the text would hand back a
   *  half-restored draft. */
  let draft: { query: string; options: SearchOptions } = {
    query: "",
    options: { ...DEFAULT_SEARCH_OPTIONS },
  };
  /** Every root the panel draws a section for, unusable members included: a
   *  member that cannot be searched still needs somewhere to say so. */
  const allRoots = (): MemberRoot[] => {
    const rs = props.roots;
    if (rs && rs.length) return rs;
    return props.root ? [{ path: props.root, repoPath: props.root, label: "" }] : [];
  };
  /** The members the results list draws a section for: every one, unusable
   *  ones included, since a member that could not be searched still needs
   *  somewhere to say so. */
  const sectionRoots = allRoots;
  /** The roots a search actually greps: the sections, minus any member that
   *  cannot be opened. An unusable member is skipped rather than invoked,
   *  because its section path is the *repo* folder and grepping it would search
   *  the user's own checkout instead of the Topic. */
  const searchRoots = () => sectionRoots().filter((r) => r.state?.usable !== false);
  /** Sections are drawn per member, so the panel is headed only alongside
   *  others; a lone root renders exactly as it always did. */
  const headed = () => allRoots().length > 1;
  const sectionOf = (root: string) => sections().find((s) => s.root === root);
  /** The searched root set as one comparable string, for the effects that must
   *  re-run when the set changes. */
  const rootsKey = () =>
    searchRoots()
      .map((r) => r.path)
      .join(NUL);
  /** Every member the panel draws, restriction ignored. What the reset effect
   *  keys on: narrowing the search with a chip changes what gets grepped, not
   *  which workspace you are in, and it must not cost the history cursor or a
   *  half-typed name. */
  const membersKey = () =>
    allRoots()
      .map((r) => r.path)
      .join(NUL);

  /** Each section's matches minus the ones dismissed, which every count, the
   *  replace targets and the editor hand-off read instead of the raw set. */
  const visibleByRoot = createMemo(() => {
    const gone = dismissed();
    const out = new Map<string, SearchMatch[]>();
    for (const s of sections()) {
      out.set(
        s.root,
        gone.size
          ? s.matches.filter((m) => !gone.has(fileKey(s.root, m.path)) && !gone.has(matchKey(s.root, m)))
          : s.matches,
      );
    }
    return out;
  });
  const visibleOf = (root: string) => visibleByRoot().get(root) ?? [];
  /** Every match on screen, in the order it is drawn. Over `sectionRoots()`
   *  rather than `sections()` because the two disagree for as long as a fresh
   *  member set's search is in flight, and the preview spans are read back by
   *  position: a row would show the previous member's expansion. */
  const allMatches = () => sectionRoots().flatMap((r) => visibleOf(r.path));
  /** The same matches, each tagged with the member it belongs to. What the
   *  Search Editor is seeded with: its rows write into their own member. */
  const rootedMatches = () => sectionRoots().flatMap((r) => visibleOf(r.path).map((m) => ({ ...m, root: r.path })));
  /** What a member is called in prose. Falls back to its path, which is what a
   *  lone root has instead of a label. */
  const labelFor = (root: string) => allRoots().find((r) => r.path === root)?.label || root;
  const docRootsOf = (roots: readonly string[]) => roots.map((root) => ({ root, label: labelFor(root) }));

  // Bumped per call, so a slower in-flight request (e.g. an fs-refresh racing
  // a fresh keystroke search) can't overwrite a newer result once it resolves.
  let searchGen = 0;
  // The capability probe needs its own latest-wins guard: switching projects
  // fires one per root, and the earlier root's probe can resolve last.
  let probeGen = 0;

  /** One root's leg. With Search Only in Open Editors on, a root holding no
   *  open file is not searched at all. */
  function legFor(root: string, q: string): Promise<RootOutcome> {
    const only = openOnly() ? openUnder(root, props.openPaths ?? []) : undefined;
    if (only && !only.length) {
      return Promise.resolve({
        root,
        result: { matches: [], truncated: false, backend: caps().backend, unsupported: [], files: [] },
      });
    }
    return grepRoot(root, q, { ...options(), only });
  }

  /** `user` searches come from a query, toggle or glob change; `refresh` ones
   *  from the fs watcher. Only the former clears results on failure, and only
   *  the former brings dismissed and collapsed rows back.
   *
   *  Returns the merged sections, or `null` when there was nothing to search,
   *  every root failed, or a newer search overtook this one. Only `openSaved`
   *  reads the return: it opens an editor over the matches, and the signal is
   *  only the answer if it was not raced. */
  async function runSearch(q: string, source: "user" | "refresh" = "user"): Promise<SearchSection[] | null> {
    const roots = searchRoots();
    if (source === "user") {
      setDismissed(new Set<string>());
      setCollapsed(new Set<string>());
    }
    if (!roots.length || !q) {
      searchGen++;
      setSections([]);
      setError(null);
      return null;
    }
    const gen = ++searchGen;
    setLoading(true);
    try {
      const legs = await Promise.all(roots.map((r) => legFor(r.path, q)));
      if (gen !== searchGen) return null;
      const merged = mergeSearchResults(legs);
      // Only a fan-out where every root failed is a panel-level error: with one
      // root that is the old behaviour exactly, and with several the surviving
      // members' hits are still the honest answer.
      const failures = merged.sections.filter((s) => s.error);
      if (failures.length === merged.sections.length) {
        if (source === "user") setSections([]);
        setError(failures[0].error);
        return null;
      }
      setSections(merged.sections);
      setCaps({ backend: backendLabel(merged.sections), unsupported: merged.unsupported });
      setError(null);
      return merged.sections;
    } finally {
      if (gen === searchGen) setLoading(false);
    }
  }

  /** How the toggle tooltips name the backend. One root answers with its own;
   *  several answer with whichever cannot honour an option, since that is the
   *  backend the disabled-reason is actually about. */
  function backendLabel(list: { backend: string; unsupported: string[] }[]): string {
    const blocking = list.find((s) => s.unsupported.length);
    return (blocking ?? list.find((s) => s.backend))?.backend ?? "";
  }

  /** Ask each backend what it can do before the first query, so a toggle no
   *  member can honour is disabled from the start rather than after a search. An
   *  empty query returns capabilities without searching anything. */
  async function probeCapabilities() {
    const roots = searchRoots();
    probeGen++;
    if (!roots.length) return setCaps({ backend: "", unsupported: [] });
    const gen = probeGen;
    const probes = await Promise.all(
      roots.map((r) =>
        // A failed probe must not disable controls; that root simply reports no
        // capabilities and a real search says what went wrong.
        invoke<SearchResult>("grep_project", grepArgs(r.path, "", options(), 0)).catch(() => null),
      ),
    );
    if (gen !== probeGen) return;
    const answered = probes.filter((p): p is SearchResult => !!p);
    if (!answered.length) return;
    setCaps({ backend: backendLabel(answered), unsupported: unionUnsupported(answered) });
  }

  /** Re-grep just the roots the watcher named, leaving the other sections as
   *  they are. A leg that fails here replaces that section with its error the
   *  same way a fresh search would; the rest keep their hits. */
  async function refreshRoots(roots: string[]) {
    const q = query();
    if (!q || !roots.length) return;
    const gen = searchGen;
    const legs = await Promise.all(roots.map((r) => legFor(r, q)));
    if (gen !== searchGen) return;
    const fresh = mergeSearchResults(legs).sections;
    setSections((prev) => prev.map((s) => fresh.find((f) => f.root === s.root) ?? s));
  }

  /** Roots the watcher touched since the last refresh fired. A set, so a burst
   *  under one member costs one grep rather than one per event. */
  const dirtyRoots = new Set<string>();

  const debouncedSearch = debounce((q: string) => void runSearch(q), INPUT_DEBOUNCE_MS);
  const debouncedRefresh = debounce(() => void runSearch(query(), "refresh"), FS_CHANGE_DEBOUNCE_MS);
  const debouncedRefreshRoots = debounce(() => {
    const roots = [...dirtyRoots];
    dirtyRoots.clear();
    void refreshRoots(roots);
  }, FS_CHANGE_DEBOUNCE_MS);
  const debouncedGlobs = debounce(() => void runSearch(query()), INPUT_DEBOUNCE_MS);

  function onInput(v: string) {
    setQuery(v);
    // Typing is leaving the history behind, so the next Up starts from what is
    // in the box now rather than from wherever the last recall stopped.
    setCursor(DRAFT);
    debouncedSearch(v);
  }

  // --- history and saved searches ---

  const ws = () => props.workspace ?? props.root ?? "";
  const recallList = () => historyFor(history(), ws());
  const savedList = () => savedFor(saved(), ws());

  createEffect(() => saveSearchHistory(history()));
  createEffect(() => saveSavedSearches(saved()));

  /**
   * Record the current query as one that was run.
   *
   * On Enter and on the two acts that spend a result set (opening the Search
   * Editor, replacing), not on every search. The box searches as you type, so
   * recording each one would fill the list with `n`, `ne`, `nee`, `need` and
   * leave nothing worth arrowing through.
   */
  function commitQuery() {
    const q = query();
    if (!q || !ws()) return;
    setHistory((h) => noteQuery(h, ws(), q, options(), []));
    setCursor(DRAFT);
  }

  /** Put a past search back in the box, toggles and all, and run it. A member
   *  narrowing stored with an older entry is ignored: Search covers every
   *  member now. */
  function applyRecall(q: string, o: SearchOptions) {
    setQuery(q);
    setOptions({ ...o });
    // Debounced like typing rather than immediate like a toggle: holding Up
    // walks the list, and each step would otherwise be its own round trip.
    debouncedSearch(q);
  }

  function recall(step: 1 | -1) {
    const list = recallList();
    const from = cursor();
    if (from === DRAFT && step === 1) {
      draft = { query: query(), options: { ...options() } };
    }
    const to = stepRecall(list, from, step);
    if (to === from) return;
    setCursor(to);
    const entry = recallAt(list, to);
    if (entry) applyRecall(entry.query, entry.options);
    else applyRecall(draft.query, draft.options);
  }

  function onQueryKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitQuery();
      // Enter is also "search now": the debounce is there to spare the backend
      // a round trip per keystroke, not to make a deliberate act wait.
      void runSearch(query());
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!recallList().length) return;
      // The caret would otherwise jump to one end of the input, which is the
      // browser's answer to a key this box has its own meaning for.
      e.preventDefault();
      recall(e.key === "ArrowUp" ? 1 : -1);
    }
  }

  /** Save the current query under the typed name, or update that name's entry. */
  function commitSave() {
    const name = saveName().trim();
    if (!name || !query() || !ws()) return;
    setSaved((s) => saveSearch(s, ws(), name, query(), options(), []));
    setSaveName("");
    setSavedNotice(null);
    commitQuery();
  }

  function commitRename(from: string, to: string) {
    setRenaming(null);
    const name = to.trim();
    setSavedNotice(null);
    if (!name || name === from) return;
    if (nameTaken(saved(), ws(), name)) {
      setSavedNotice(`A saved search is already named "${name}".`);
      return;
    }
    setSaved((s) => renameSearch(s, ws(), from, name));
  }

  /** The Search Editor's form for what is in the panel now. */
  const editorForm = () => ({
    query: query(),
    options: { ...options() },
    repos: [],
    context: DEFAULT_CONTEXT_LINES,
    showContext: true,
    openOnly: openOnly(),
  });

  /**
   * Run a saved search and hand its hits straight to a Search Editor.
   *
   * Opening a saved search means arriving at the thing it names, which is a
   * buffer you can edit and write back, not a list to click through. The panel
   * is restored too, so the toggles on screen still describe what you are
   * looking at. A search that matches nothing opens no tab.
   */
  async function openSaved(s: SavedSearch) {
    setCursor(DRAFT);
    setQuery(s.query);
    setOptions({ ...s.options });
    setHistory((h) => noteQuery(h, ws(), s.query, s.options, []));
    const fresh = await runSearch(s.query);
    if (!fresh) return;
    const matches = fresh.flatMap((sec) => sec.matches.map((m) => ({ ...m, root: sec.root })));
    if (matches.length) {
      openSearchEditor(ws(), editorForm(), { matches, roots: docRootsOf(fresh.map((sec) => sec.root)) });
    }
  }

  // A toggle click is one deliberate act, not a keystroke, so it re-searches
  // immediately instead of waiting out the input debounce.
  function toggleOption(key: ToggleKey) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
    void runSearch(query());
  }

  function toggleOpenOnly() {
    setOpenOnly((v) => !v);
    void runSearch(query());
  }

  function setGlob(key: "include" | "exclude", v: string) {
    setOptions((o) => ({ ...o, [key]: v }));
    debouncedGlobs();
  }

  // --- replace ---

  const replaceOptions = () => ({ ...options(), preserveCase: preserveCase() });

  /** Flat list of every displayed span, in render order, so a preview response
   *  can be read back positionally. */
  const flatSpans = () =>
    allMatches().flatMap((m) => m.submatches.map(([start, end]) => ({ text: m.text, start, end })));

  /** Where each match's spans begin within `flatSpans()`. Memoised because the
   *  alternative is rescanning the result set once per rendered span, which is
   *  quadratic at the 500-line cap. */
  const previewBase = createMemo(() => {
    const base = new Map<SearchMatch, number>();
    let i = 0;
    for (const m of allMatches()) {
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
    if (!spans.length) return setPreview([]);
    const gen = ++previewGen;
    try {
      const out = await invoke<(string | null)[]>("preview_replace", {
        query: query(),
        options: replaceOptions(),
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

  const dirtyPathsFor = (root: string) => dirtyRelativePaths(root, props.dirty ?? {});
  /** One root's replace targets, built from that root's visible matches and its
   *  own digests. Keeping the fence per root is what stops a file that moved
   *  under one member from blocking a write to another. */
  const targetsFor = (s: SearchSection) => replaceTargets(visibleOf(s.root), s.files, dirtyPathsFor(s.root));
  /** Every root that has something to replace, each carrying its own targets.
   *  A bare relative path is not an identity here: two members routinely hold
   *  the same `src/index.ts`, so nothing selects a target by path alone. */
  type RootTargets = { root: string; targets: { path: string; digest: string; matches: ReplaceSpan[] }[] };
  const allTargets = (): RootTargets[] =>
    sections()
      .map((s) => ({ root: s.root, targets: targetsFor(s) }))
      .filter((g) => g.targets.length);
  const targetFileCount = () => allTargets().reduce((n, g) => n + g.targets.length, 0);
  /** Any member at its cap disables Replace All for the whole set, not just for
   *  that member. A capped section is a subset of its real matches, and one
   *  button reading "replace everything" that quietly means "everywhere except
   *  the repo that overflowed" is the reading worth ruling out. */
  const anyTruncated = () => sections().some((s) => s.truncated);
  const replacing = () => showReplace();

  /** Why a file was skipped, phrased for the outcome line. Inside a Topic the
   *  reason alone is not actionable: two members routinely hold the same
   *  `src/index.ts`, so it has to say which one to go and deal with. */
  const skipReason = (root: string, reason: string) => (headed() ? `${reason} in ${labelFor(root)}` : reason);

  /** Apply each root's targets against that root, then report once and
   *  re-search. The re-search matters beyond freshness: it is what proves on
   *  screen that the write landed. */
  async function applyReplace(groups: RootTargets[], skippedForDirt: { root: string; path: string }[] = []) {
    // One replace at a time. A second would find every digest already moved and
    // report "0 replaced, N skipped (changed on disk)" for work that in fact
    // succeeded, which reads as a failure.
    if (!groups.length || applying()) return;
    setApplying(true);
    // A query you replaced with is one you stood behind, whether or not you
    // ever pressed Enter on it.
    commitQuery();
    try {
      let occurrences = 0;
      const changed: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const g of groups) {
        const out = await invoke<ReplaceOutcome>("replace_in_files", {
          root: g.root,
          query: query(),
          options: replaceOptions(),
          replacement: replacement(),
          targets: g.targets,
        });
        // Deliberately NOT markSelfWrite: the buffers of open files do not hold
        // this edit, so suppressing the watcher echo would leave a clean tab
        // showing pre-replace text whose next save would silently revert it.
        occurrences += out.occurrences;
        changed.push(...out.changed);
        skipped.push(...out.skipped.map((s) => ({ path: s.path, reason: skipReason(g.root, s.reason) })));
      }
      skipped.push(
        ...skippedForDirt.map(({ root, path }) => ({
          path,
          reason: skipReason(root, "unsaved changes"),
        })),
      );
      setOutcome(replaceOutcome(occurrences, changed, skipped));
      setError(null);
      await runSearch(query());
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  async function replaceAll() {
    const groups = allTargets();
    if (!groups.length || applying() || anyTruncated()) return;
    const occurrences = groups.reduce((n, g) => n + g.targets.reduce((m, t) => m + t.matches.length, 0), 0);
    const files = targetFileCount();
    const ok = props.confirm
      ? await props.confirm({
          title: `Replace ${plural(occurrences, "occurrence")} in ${plural(files, "file")}?`,
          message: "This writes to disk and cannot be undone from here.",
          confirmLabel: "Replace",
        })
      : true;
    if (!ok) return;
    const dirtyHits = sections().flatMap((s) =>
      dirtyPathsFor(s.root)
        .filter((p) => visibleOf(s.root).some((m) => m.path === p))
        .map((path) => ({ root: s.root, path })),
    );
    await applyReplace(groups, dirtyHits);
  }

  function replacePaths(root: string, paths: readonly string[]) {
    const g = allTargets().find((x) => x.root === root);
    const targets = g?.targets.filter((t) => paths.includes(t.path)) ?? [];
    if (targets.length) void applyReplace([{ root, targets }]);
  }

  // --- the result list ---

  const isCollapsed = (key: string) => collapsed().has(key);
  function toggleCollapsed(key: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  const fileKeys = () =>
    sectionRoots().flatMap((r) => groupByFile(visibleOf(r.path)).map((g) => fileKey(r.path, g.path)));
  const allCollapsed = () => {
    const keys = fileKeys();
    return keys.length > 0 && keys.every((k) => collapsed().has(k));
  };
  function collapseOrExpandAll() {
    if (allCollapsed()) return setCollapsed(new Set<string>());
    const keys = new Set(fileKeys());
    for (const r of sectionRoots()) {
      for (const p of folderPaths(folderTree(groupByFile(visibleOf(r.path))))) keys.add(folderKey(r.path, p));
    }
    setCollapsed(keys);
  }

  function dismiss(keys: string[]) {
    setDismissed((d) => new Set([...d, ...keys]));
  }

  function setView(tree: boolean) {
    setAsTree(tree);
    try {
      localStorage.setItem(VIEW_KEY, tree ? "tree" : "list");
    } catch {
      // Storage blocked: the view still holds for this run.
    }
  }

  const openMatch = (root: string, path: string, line: number) =>
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: `${root}/${path}`, line });

  /** The results as VS Code's Copy All writes them. */
  function resultsText(root?: string, paths?: readonly string[]) {
    const roots = root ? [root] : sectionRoots().map((r) => r.path);
    const blocks: string[] = [];
    for (const r of roots) {
      for (const g of groupByFile(visibleOf(r))) {
        if (paths && !paths.includes(g.path)) continue;
        const lines = g.matches.map((m) => `  ${m.line},${(m.submatches[0]?.[0] ?? 0) + 1}: ${m.text.trim()}`);
        blocks.push([headed() ? `${labelFor(r)}/${g.path}` : g.path, ...lines].join("\n"));
      }
    }
    return blocks.join("\n\n");
  }

  const copyPathItems = (root: string, rel: string): MenuItem[] => [
    { label: "Copy Path", onClick: () => void copyText(rel ? `${root}/${rel}` : root) },
    { label: "Copy Relative Path", onClick: () => void copyText(rel) },
  ];

  function fileMenu(root: string, g: FileGroup): MenuItem[] {
    const abs = `${root}/${g.path}`;
    return [
      { label: "Open to the Side", onClick: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: abs, side: true }) },
      {
        label: "Reveal in Files",
        onClick: () => {
          emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: abs });
          emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "files" });
        },
      },
      { separator: true },
      ...(replacing()
        ? [{ label: "Replace All", disabled: applying(), onClick: () => replacePaths(root, [g.path]) }]
        : []),
      { label: "Dismiss", onClick: () => dismiss([fileKey(root, g.path)]) },
      { separator: true },
      ...copyPathItems(root, g.path),
      { label: "Copy All", onClick: () => void copyText(resultsText()) },
    ];
  }

  function folderMenu(root: string, node: FolderNode): MenuItem[] {
    const files = filesUnder(node).map((f) => f.path);
    return [
      {
        label: "Restrict Search to Folder",
        onClick: () => {
          setOptions((o) => ({ ...o, include: `${node.path}/**` }));
          setShowGlobs(true);
          void runSearch(query());
        },
      },
      {
        label: "Exclude Folder from Search",
        onClick: () => {
          setOptions((o) => ({ ...o, exclude: [o.exclude, `${node.path}/**`].filter(Boolean).join(", ") }));
          setShowGlobs(true);
          void runSearch(query());
        },
      },
      { separator: true },
      ...(replacing()
        ? [{ label: "Replace All", disabled: applying(), onClick: () => replacePaths(root, files) }]
        : []),
      { label: "Dismiss", onClick: () => dismiss(files.map((p) => fileKey(root, p))) },
      { separator: true },
      ...copyPathItems(root, node.path),
      { label: "Copy All", onClick: () => void copyText(resultsText(root, files)) },
    ];
  }

  function matchMenu(root: string, m: SearchMatch): MenuItem[] {
    return [
      { label: "Copy", onClick: () => void copyText(m.text.trim()) },
      { label: "Copy Path", onClick: () => void copyText(`${root}/${m.path}:${m.line}`) },
      { label: "Copy All", onClick: () => void copyText(resultsText()) },
      { separator: true },
      ...(replacing()
        ? [
            {
              label: "Replace",
              disabled: applying() || dirtyPathsFor(root).includes(m.path),
              onClick: () => replaceSpans(root, m),
            },
          ]
        : []),
      { label: "Dismiss", onClick: () => dismiss([matchKey(root, m)]) },
    ];
  }

  /** Replace every span on one line, VS Code's per-match Replace. */
  function replaceSpans(root: string, m: SearchMatch) {
    const target = allTargets()
      .find((x) => x.root === root)
      ?.targets.find((t) => t.path === m.path);
    if (!target) return;
    const spans = m.submatches.map(([start, end]) => ({ line: m.line, start, end }));
    void applyReplace([{ root, targets: [{ ...target, matches: spans }] }]);
  }

  // A match sits under its file's name, past the chevron and the file icon.
  const indent = (depth: number, extra = 0) => ({
    "padding-left": `calc(${depth * 12 + 8}px + ${extra} * var(--control-icon))`,
  });

  function MatchRow(p: { root: string; m: SearchMatch; depth: number }) {
    const segments = createMemo(() => previewSegments(p.m.text, p.m.submatches));
    const showPreview = () => replacing() && preview().length > 0;
    return (
      <ContextMenu
        items={matchMenu(p.root, p.m)}
        class={`${tree.treeRow} ${styles.row}`}
        style={indent(p.depth, 1.5)}
        data-line={p.m.line}
        onClick={() => openMatch(p.root, p.m.path, p.m.line)}
      >
        <span class={styles.matchText}>
          <For each={segments()}>
            {(seg) => {
              if (seg.hit === null) return <>{seg.text}</>;
              const next = () => preview()[previewIndex(p.m, seg.hit!)];
              return (
                <Show when={showPreview() && next() != null} fallback={<mark class={styles.hit}>{seg.text}</mark>}>
                  <del class={styles.previewOld}>{seg.text}</del>
                  <ins class={styles.previewNew}>{next()}</ins>
                </Show>
              );
            }}
          </For>
        </span>
        <span class={`${styles.rowEnd} ${styles.rowActions}`}>
          <Show when={replacing()}>
            <RowAction
              icon={Replace}
              label="Replace"
              disabled={applying() || dirtyPathsFor(p.root).includes(p.m.path)}
              onClick={() => replaceSpans(p.root, p.m)}
            />
          </Show>
          <RowAction icon={X} label="Dismiss" onClick={() => dismiss([matchKey(p.root, p.m)])} />
        </span>
      </ContextMenu>
    );
  }

  function FileBlock(p: { root: string; group: FileGroup; depth: number }) {
    const key = () => fileKey(p.root, p.group.path);
    const count = () => countOccurrences(p.group.matches);
    return (
      <>
        <ContextMenu
          items={fileMenu(p.root, p.group)}
          class={`${tree.treeRow} ${styles.row}`}
          style={indent(p.depth)}
          data-file={p.group.path}
          onClick={() => toggleCollapsed(key())}
        >
          <Chevron open={!isCollapsed(key())} />
          <FileIcon name={baseName(p.group.path)} />
          <span class={styles.fileName}>{baseName(p.group.path)}</span>
          <Show when={!asTree() && dirName(p.group.path)}>
            <span class={styles.fileDir}>{dirName(p.group.path)}</span>
          </Show>
          <span class={styles.rowEnd}>
            <span class={styles.rowActions}>
              <Show when={replacing()}>
                <RowAction
                  icon={ReplaceAll}
                  label="Replace All"
                  disabled={applying() || dirtyPathsFor(p.root).includes(p.group.path)}
                  onClick={() => replacePaths(p.root, [p.group.path])}
                />
              </Show>
              <RowAction icon={X} label="Dismiss" onClick={() => dismiss([key()])} />
            </span>
            <span class={styles.badge}>{count()}</span>
          </span>
        </ContextMenu>
        <Show when={!isCollapsed(key())}>
          <For each={p.group.matches}>{(m) => <MatchRow root={p.root} m={m} depth={p.depth} />}</For>
        </Show>
      </>
    );
  }

  function FolderChildren(p: { root: string; node: FolderNode; depth: number }): JSX.Element {
    return (
      <>
        <For each={p.node.folders}>{(f) => <FolderBlock root={p.root} node={f} depth={p.depth} />}</For>
        <For each={p.node.files}>{(g) => <FileBlock root={p.root} group={g} depth={p.depth} />}</For>
      </>
    );
  }

  function FolderBlock(p: { root: string; node: FolderNode; depth: number }) {
    const key = () => folderKey(p.root, p.node.path);
    const files = () => filesUnder(p.node);
    const count = () => files().reduce((n, f) => n + countOccurrences(f.matches), 0);
    return (
      <>
        <ContextMenu
          items={folderMenu(p.root, p.node)}
          class={`${tree.treeRow} ${styles.row}`}
          style={indent(p.depth)}
          data-folder={p.node.path}
          onClick={() => toggleCollapsed(key())}
        >
          <Chevron open={!isCollapsed(key())} />
          <span class={styles.fileName}>{p.node.name}</span>
          <span class={styles.rowEnd}>
            <span class={styles.rowActions}>
              <Show when={replacing()}>
                <RowAction
                  icon={ReplaceAll}
                  label="Replace All"
                  disabled={applying()}
                  onClick={() =>
                    replacePaths(
                      p.root,
                      files().map((f) => f.path),
                    )
                  }
                />
              </Show>
              <RowAction
                icon={X}
                label="Dismiss"
                onClick={() => dismiss(files().map((f) => fileKey(p.root, f.path)))}
              />
            </span>
            <span class={styles.badge}>{count()}</span>
          </span>
        </ContextMenu>
        <Show when={!isCollapsed(key())}>
          <FolderChildren root={p.root} node={p.node} depth={p.depth + 1} />
        </Show>
      </>
    );
  }

  // Keyed on the member set and the workspace, deliberately not on `props.root`
  // (inside a Topic that is the *active member*, and clicking a Toolbar chip
  // to read another member's file must not spend a search that spans all of
  // them) and not on the searched set either, which the restriction moves.
  // A real workspace change moves both of these.
  createEffect(
    on(
      () => `${props.workspace ?? ""}${NUL}${membersKey()}`,
      () => {
        setSections([]);
        setError(null);
        // Everything below is scoped to a workspace, and none of it means
        // anything in the next one: a cursor indexes the history that was
        // there, and the draft it would restore is a query for the project you
        // just left. Carrying them over is how the first arrow press after a
        // switch puts someone else's half-typed text in the box.
        setCursor(DRAFT);
        draft = { query: "", options: { ...DEFAULT_SEARCH_OPTIONS } };
        setRenaming(null);
        setSaveName("");
        setSavedNotice(null);
        void probeCapabilities();
      },
    ),
  );

  // Re-preview when the replacement text or its case rule changes, a new result
  // set arrives, or the replace row is reopened. `showReplace` has to be a
  // dependency and not just a read: reopening the row after the results changed
  // underneath it would otherwise show no preview until the text was retyped.
  createEffect(
    on([replacement, preserveCase, visibleByRoot, showReplace], () => {
      if (showReplace()) debouncedPreview();
      else setPreview([]);
    }),
  );

  // A replace outcome describes one past action. Anything that changes what is
  // on screen retires it, so a success line can never sit above results it had
  // nothing to do with.
  createEffect(on([query, options, rootsKey], () => setOutcome(null), { defer: true }));

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

  createEffect(
    on(
      () => props.scope?.nonce,
      () => {
        const s = props.scope;
        if (!s) return;
        setOptions((o) => ({ ...o, include: `${s.rel}/**` }));
        setShowGlobs(true);
        props.onScoped?.();
        if (query()) void runSearch(query());
        requestAnimationFrame(() => inputEl?.focus());
      },
    ),
  );

  /** The results on screen as a Search Editor tab. */
  function openInEditor() {
    if (!hitCount()) return;
    commitQuery();
    openSearchEditor(ws(), editorForm(), {
      matches: rootedMatches(),
      roots: docRootsOf(sectionRoots().map((r) => r.path)),
    });
  }

  let unlistenFs: UnlistenFn | undefined;
  onMount(() => {
    inputEl?.focus();
  });
  onMount(async () => {
    unlistenFs = await listen<FsChanged>("fs://changed", (e) => {
      if (!query()) return;
      const changed = e.payload.root;
      // An event names one root, so only that root is re-grepped and its section
      // is merged back over the others. Re-running the whole fan-out would cost
      // one grep per member per burst, in exactly the Topic that has an agent
      // writing in one of them. An event with no root refreshes everything.
      if (!changed) return debouncedRefresh();
      if (!searchRoots().some((r) => r.path === changed)) return;
      dirtyRoots.add(changed);
      debouncedRefreshRoots();
    });
  });
  onCleanup(() => {
    unlistenFs?.();
    // A pending debounce outlives the panel that queued it: close Search within
    // the input debounce and the backend still runs that grep, for a component
    // whose signals nothing reads any more.
    debouncedSearch.cancel();
    debouncedRefresh.cancel();
    debouncedRefreshRoots.cancel();
    debouncedGlobs.cancel();
    debouncedPreview.cancel();
  });

  /** Per section, never once for the set: a cap reached in one repo says nothing
   *  about another, and one notice over three members names none of them. */
  const noticeFor = (s: SearchSection) => truncationNotice(s.truncated, MAX_RESULTS, countOccurrences(s.matches));
  const hitCount = () => allMatches().length;
  const fileCount = () => sectionRoots().reduce((n, r) => n + groupByFile(visibleOf(r.path)).length, 0);

  return (
    <div class={styles.searchPanel}>
      <div class={styles.topBar}>
        <span class={styles.title}>Search</span>
        <span class={styles.spacer} />
        <IconButton
          size="sm"
          icon={<Icon icon={RefreshCw} />}
          tooltip="Refresh"
          disabled={!query()}
          onClick={() => void runSearch(query())}
        />
        <IconButton
          size="sm"
          icon={<Icon icon={FilePlus2} />}
          tooltip="Open New Search Editor"
          disabled={!ws()}
          onClick={() => openSearchEditor(ws())}
        />
        <IconButton
          size="sm"
          icon={<Icon icon={Star} />}
          class={styles.pressable}
          aria-pressed={showSaved()}
          tooltip="Saved Searches"
          aria-expanded={showSaved()}
          aria-controls={SAVED_ID}
          onClick={() => setShowSaved((v) => !v)}
        />
        <IconButton
          size="sm"
          icon={<Icon icon={asTree() ? List : ListTree} />}
          tooltip={asTree() ? "View as List" : "View as Tree"}
          onClick={() => setView(!asTree())}
        />
        <IconButton
          size="sm"
          icon={<Icon icon={allCollapsed() ? ChevronsUpDown : ChevronsDownUp} />}
          tooltip={allCollapsed() ? "Expand All" : "Collapse All"}
          disabled={!hitCount()}
          onClick={collapseOrExpandAll}
        />
      </div>
      <div class={styles.form}>
        <div class={styles.queryRow}>
          <IconButton
            icon={<Icon icon={Replace} />}
            class={styles.pressable}
            aria-pressed={showReplace()}
            tooltip="Toggle Replace"
            aria-expanded={showReplace()}
            onClick={() => setShowReplace((v) => !v)}
          />
          {/* A description rather than a tooltip: a tooltip on a text box opens
              on focus and sits over the results for as long as you type. */}
          <Field
            ref={(el) => (inputEl = el)}
            value={query()}
            label="Search"
            placeholder="Search"
            describedBy={QUERY_HINT_ID}
            onInput={onInput}
            onKeyDown={onQueryKeyDown}
          >
            <MatchToggles
              options={options()}
              unsupported={caps().unsupported}
              backend={caps().backend}
              onToggle={toggleOption}
            />
          </Field>
          {/* Beside the box it opens the include and exclude fields under. */}
          <IconButton
            icon={<Icon icon={SlidersHorizontal} />}
            class={styles.pressable}
            aria-pressed={showGlobs()}
            tooltip="Toggle Search Details"
            aria-expanded={showGlobs()}
            aria-controls={GLOBS_ID}
            onClick={() => setShowGlobs((v) => !v)}
          />
        </div>
        <span id={QUERY_HINT_ID} class={styles.srOnly}>
          Enter searches now and remembers the query; Up and Down walk what you have searched here
        </span>
        <Show when={showReplace()}>
          <Field
            value={replacement()}
            label="Replace"
            placeholder="Replace"
            onInput={setReplacement}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void replaceAll();
              }
            }}
          >
            <InlineToggle
              icon={CaseUpper}
              label="Preserve Case"
              active={preserveCase()}
              onClick={() => setPreserveCase((v) => !v)}
            />
            {/* A capped result set is a subset of the real matches, so a
                "replace everything" that silently means "replace the first
                500" is the one action that must not be offered here. */}
            <InlineToggle
              icon={ReplaceAll}
              label={
                anyTruncated()
                  ? "Refine the search first: Replace All is disabled while results are capped"
                  : "Replace All"
              }
              disabled={anyTruncated() || !allTargets().length || applying()}
              onClick={() => void replaceAll()}
            />
          </Field>
        </Show>
        <Show when={showGlobs()}>
          <GlobFields
            id={GLOBS_ID}
            options={options()}
            unsupported={caps().unsupported}
            backend={caps().backend}
            openOnly={openOnly()}
            onGlob={setGlob}
            onOpenOnly={toggleOpenOnly}
            onToggleIgnore={() => toggleOption("noIgnore")}
          />
        </Show>
      </div>
      <Show when={showSaved()}>
        <div class={styles.savedRow} id={SAVED_ID}>
          <div class={styles.saveBar}>
            <input
              class={styles.globInput}
              type="text"
              aria-label="Name this search"
              placeholder="Name this search"
              value={saveName()}
              onInput={(e) => setSaveName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitSave();
                }
              }}
            />
            <Button
              size="xs"
              // A name with no query behind it would save a row that runs
              // nothing, so the query is as required as the name is.
              disabled={!saveName().trim() || !query()}
              tooltip={
                nameTaken(saved(), ws(), saveName())
                  ? `Update the saved search named "${saveName().trim()}"`
                  : "Save this query and its toggles under that name"
              }
              onClick={commitSave}
            >
              {nameTaken(saved(), ws(), saveName()) ? "Update" : "Save"}
            </Button>
          </div>
          <Show when={savedNotice()}>
            <div class={styles.savedNotice} role="status">
              {savedNotice()}
            </div>
          </Show>
          <Show when={savedList().length} fallback={<div class="tree-empty">No saved searches here yet</div>}>
            <ul class={styles.savedList}>
              <For each={savedList()}>
                {(s) => (
                  <li class={styles.savedItem}>
                    <Show
                      when={renaming() === s.name}
                      fallback={
                        <Tooltip
                          as="button"
                          type="button"
                          class={styles.savedName}
                          label={`${s.query} - opens in a Search Editor`}
                          onClick={() => void openSaved(s)}
                        >
                          {s.name}
                        </Tooltip>
                      }
                    >
                      <input
                        class={styles.globInput}
                        type="text"
                        aria-label={`New name for ${s.name}`}
                        value={s.name}
                        // `autofocus` is honoured when the parser meets it,
                        // not when a `Show` inserts the element later, so the
                        // focus is asked for a frame after it is in the DOM.
                        ref={(el) => requestAnimationFrame(() => el.select())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(s.name, e.currentTarget.value);
                          } else if (e.key === "Escape") setRenaming(null);
                        }}
                        // Enter is the only thing that renames. Committing on
                        // blur too would mean Escape (which unmounts this
                        // input, and so blurs it) applied the rename it was
                        // pressed to call off.
                        onBlur={() => setRenaming(null)}
                      />
                    </Show>
                    <IconButton
                      size="xs"
                      icon={<Icon icon={Pencil} size={12} />}
                      aria-label={`Rename ${s.name}`}
                      tooltip={`Rename ${s.name}`}
                      onClick={() => setRenaming(s.name)}
                    />
                    <IconButton
                      size="xs"
                      icon={<Icon icon={Trash2} size={12} />}
                      aria-label={`Delete ${s.name}`}
                      tooltip={`Delete ${s.name}`}
                      onClick={() => setSaved((st) => deleteSearch(st, ws(), s.name))}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
      <Show when={outcome()}>
        <div class={styles.message}>{outcome()}</div>
      </Show>
      <Show when={error()}>
        <div class={styles.message}>{error()}</div>
      </Show>
      <Show when={!error() && query() && !loading() && !hitCount()}>
        <div class={styles.message}>No results found.</div>
      </Show>
      <Show when={!error() && hitCount()}>
        <div class={styles.message}>
          {plural(countOccurrences(allMatches()), "result")} in {plural(fileCount(), "file")}
          {" - "}
          <button type="button" class={styles.link} onClick={openInEditor}>
            Open in editor
          </button>
        </div>
      </Show>
      <div class={styles.results}>
        {/* Sections iterate over the roots, not over `sections()`: a member with
            no worktree never runs a grep and so has no result to iterate, yet it
            still needs a header to say why it is empty. */}
        <For each={sectionRoots()}>
          {(member) => {
            const found = () => sectionOf(member.path);
            const unusable = () => member.state?.usable === false;
            const files = createMemo(() => groupByFile(visibleOf(member.path)));
            const folders = createMemo(() => folderTree(files()));
            const depth = () => (headed() ? 1 : 0);
            return (
              <div class={styles.section} data-root={member.path}>
                <Show when={headed()}>
                  <div
                    class={`${tree.treeRow} ${styles.row} ${styles.memberRow}`}
                    onClick={() => toggleCollapsed(memberKey(member.path))}
                  >
                    {/* The Spaces project row's icon slot: the project at
                        rest, the disclosure under the pointer. */}
                    <span class={styles.memberIcon}>
                      <span class={styles.memberIconArt}>
                        <MemberChip icon={member.icon ?? { seed: member.repoPath }} bare decorative />
                      </span>
                      <span class={styles.memberIconChevron} aria-hidden="true">
                        <Chevron open={!isCollapsed(memberKey(member.path))} />
                      </span>
                    </span>
                    <span class={styles.fileName}>{member.label}</span>
                    <Show when={!unusable()}>
                      <span class={styles.rowEnd}>
                        <span class={styles.badge}>{countOccurrences(visibleOf(member.path))}</span>
                      </span>
                    </Show>
                  </div>
                </Show>
                <Show when={!isCollapsed(memberKey(member.path))}>
                  {/* Three ways a section says nothing was found, and they are
                      not the same answer: it could not be searched, it failed,
                      or it was searched and had no hits. */}
                  <Show when={unusable()}>
                    <div class="tree-empty">{member.state?.label}: not searched</div>
                  </Show>
                  <Show when={found()?.error}>
                    <div class="tree-empty">{found()!.error}</div>
                  </Show>
                  <Show when={found() && noticeFor(found()!)}>
                    <div class={styles.truncatedNotice}>{noticeFor(found()!)}</div>
                  </Show>
                  <Show
                    when={asTree()}
                    fallback={
                      <For each={files()}>{(g) => <FileBlock root={member.path} group={g} depth={depth()} />}</For>
                    }
                  >
                    <FolderChildren root={member.path} node={folders()} depth={depth()} />
                  </Show>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
