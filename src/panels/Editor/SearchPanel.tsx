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
  FilePen,
  Pencil,
  Regex,
  Replace,
  ReplaceAll,
  Star,
  Trash2,
  WholeWord,
  type LucideIcon,
} from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import { emitWith, onWith, OPEN_IN_EDITOR, PURGE_WORKSPACE, type FsChanged, type PurgeWorkspace } from "../../utils/events";
import { dropWorkspaceKey } from "../../utils/purgeWorkspace";
import { debounce } from "../../utils/debounce";
import {
  DEFAULT_SEARCH_OPTIONS,
  countOccurrences,
  dirtyRelativePaths,
  grepArgs,
  isUnsupported,
  mergeSearchResults,
  replaceOutcome,
  replaceTargets,
  splitHighlights,
  truncationNotice,
  unionUnsupported,
  unsupportedReason,
  type SearchMatch,
  type SearchOptions,
  type SearchResult,
  type SearchSection,
  type Submatch,
  type ToggleKey,
} from "../../utils/searchOptions";
import { memberInitials } from "../../utils/features";
import MemberChip from "../../components/MemberChip/MemberChip";
import { resolveMemberRestriction, type MemberRoot } from "../../utils/featureMembers";
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
import { openSearchResults } from "./searchResultsStore";
import styles from "./SearchPanel.module.css";

type FileGroup = { path: string; matches: SearchMatch[] };
/** What the backends can do here, kept apart from `sections` so clearing results
 *  (an empty query, a workspace switch) does not also blank the toggle states.
 *  Unioned across members: a toggle one member cannot honour is disabled for
 *  all of them, since its result set would be a lie for that member. */
type Capabilities = { backend: string; unsupported: string[] };
type ReplaceOutcome = { changed: string[]; skipped: { path: string; reason: string }[]; occurrences: number };
/** One span to replace, as `replace_in_files` takes it. */
type ReplaceSpan = { line: number; start: number; end: number };

/** Per root, not shared across them: truncation is reported per section, and one
 *  budget split across members would let a noisy repo starve the rest. */
const MAX_RESULTS = 500;
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
 *  grouped by member and then by file with per-file match counts, click opens
 *  the file at the matched line. Inside a Feature every member is searched at
 *  once: `grep_project` stays single-root and this panel fans out and merges,
 *  because the sections, the per-member truncation and the per-member replace
 *  targets have to exist here whatever the backend returns. Refreshes on `fs://changed` (its own, longer debounce) only
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
  /** The multi-root form, one section per Feature member. A branch unit passes
   *  none and the panel searches `root` alone, headerless, exactly as it did. */
  roots?: MemberRoot[];
  /** The store key history and saved searches live under; defaults to `root`. */
  workspace?: string;
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
  /** The member **repo paths** the search is narrowed to; empty means every
   *  member. Repo paths rather than the section paths a grep takes, because
   *  this is the value that gets saved with a search and a repaired worktree
   *  moves the section path out from under it. */
  const [restricted, setRestricted] = createSignal<readonly string[]>([]);
  /** One entry per searched root, in member order. Empty until a search runs. */
  const [sections, setSections] = createSignal<SearchSection[]>([]);
  const [caps, setCaps] = createSignal<Capabilities>({ backend: "", unsupported: [] });
  const [preview, setPreview] = createSignal<(string | null)[]>([]);
  const [outcome, setOutcome] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Both stores are read and written only here, so they load on mount and write
  // through on every change rather than living in the Editor beside the
  // bookmarks: this panel is torn down whenever another right-hand mode is
  // picked, and re-reading them is what makes that survivable.
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
  let draft: { query: string; options: SearchOptions; repos: readonly string[] } = {
    query: "",
    options: { ...DEFAULT_SEARCH_OPTIONS },
    repos: [],
  };
  /** Every root the panel draws a section for, unusable members included: a
   *  member that cannot be searched still needs somewhere to say so. */
  const allRoots = (): MemberRoot[] => {
    const rs = props.roots;
    if (rs && rs.length) return rs;
    return props.root ? [{ path: props.root, repoPath: props.root, label: "" }] : [];
  };
  /** The restriction as it applies to the members on screen right now. Resolved
   *  rather than read raw, so a stored restriction naming a member that has
   *  gone narrows to what is left rather than to nothing. */
  const restriction = createMemo(() => resolveMemberRestriction(restricted(), allRoots()));
  /** The members the results list draws a section for. Unusable ones stay, since
   *  a member that could not be searched still needs somewhere to say so;
   *  restricted-away ones go, because a bare header over no hits reads as
   *  "searched, nothing here" when it was never searched at all. */
  const sectionRoots = () => {
    const only = restriction();
    return only.length ? allRoots().filter((r) => only.includes(r.repoPath)) : allRoots();
  };
  /** The roots a search actually greps: the sections, minus any member that
   *  cannot be opened. An unusable member is skipped rather than invoked,
   *  because its section path is the *repo* folder and grepping it would search
   *  the user's own checkout instead of the Feature. */
  const searchRoots = () => sectionRoots().filter((r) => r.state?.usable !== false);
  /** Sections are drawn per member, so the panel is headed only alongside
   *  others; a lone root renders exactly as it always did. Based on the whole
   *  member set, not the restricted one: narrowing to a single member is
   *  exactly when its name still needs to be on screen. */
  const headed = () => allRoots().length > 1;
  const sectionOf = (root: string) => sections().find((s) => s.root === root);
  /** The searched root set as one comparable string, for the effects that must
   *  re-run when the set changes. NUL-joined, not space-joined: a path may
   *  contain a space, and two different sets must never spell the same key. */
  const rootsKey = () => searchRoots().map((r) => r.path).join(NUL);
  /** Every member the panel draws, restriction ignored. What the reset effect
   *  keys on: narrowing the search with a chip changes what gets grepped, not
   *  which workspace you are in, and it must not cost the history cursor or a
   *  half-typed name. */
  const membersKey = () => allRoots().map((r) => r.path).join(NUL);
  /** Every match on screen, in the order it is drawn. Over `sectionRoots()`
   *  rather than `sections()` because the two disagree for as long as a fresh
   *  restriction's search is in flight, and the preview spans are read back by
   *  position: a row would show the previous member's expansion. */
  const allMatches = () => sectionRoots().flatMap((r) => sectionOf(r.path)?.matches ?? []);
  /** The same matches, each tagged with the member it belongs to. What the
   *  editable buffer is built from: its rows write into their own member. */
  const rootedMatches = () =>
    sectionRoots().flatMap((r) =>
      (sectionOf(r.path)?.matches ?? []).map((m) => ({ ...m, root: r.path })),
    );
  /** What a member is called in prose. Falls back to its path, which is what a
   *  lone root has instead of a label. */
  const labelFor = (root: string) => allRoots().find((r) => r.path === root)?.label || root;
  const docRootsOf = (roots: readonly string[]) =>
    roots.map((root) => ({ root, label: labelFor(root) }));

  // Bumped per call, so a slower in-flight request (e.g. an fs-refresh racing
  // a fresh keystroke search) can't overwrite a newer result once it resolves.
  let searchGen = 0;
  // The capability probe needs its own latest-wins guard: switching projects
  // fires one per root, and the earlier root's probe can resolve last.
  let probeGen = 0;

  /** One root's leg of the fan-out. It never throws: a member whose grep fails
   *  reports in its own section, so one unreadable repo cannot blank the
   *  members that answered. */
  async function grepRoot(root: string, q: string) {
    try {
      return { root, result: await invoke<SearchResult>("grep_project", grepArgs(root, q, options(), MAX_RESULTS)) };
    } catch (e) {
      return { root, error: String(e) };
    }
  }

  /** `user` searches come from a query, toggle or glob change; `refresh` ones
   *  from the fs watcher. Only the former clears results on failure.
   *
   *  Fans out one `grep_project` per searchable root and merges. Returns the
   *  merged sections, or `null` when there was nothing to search, every root
   *  failed, or a newer search overtook this one. Every caller but `openSaved`
   *  ignores the return and reads the signal; that one needs the matches in
   *  hand, because it opens a buffer over them and the signal is only the
   *  answer if it was not raced. */
  async function runSearch(
    q: string,
    source: "user" | "refresh" = "user",
  ): Promise<SearchSection[] | null> {
    const roots = searchRoots();
    if (!roots.length || !q) {
      searchGen++;
      setSections([]);
      setError(null);
      return null;
    }
    const gen = ++searchGen;
    setLoading(true);
    try {
      const legs = await Promise.all(roots.map((r) => grepRoot(r.path, q)));
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
    const legs = await Promise.all(roots.map((r) => grepRoot(r, q)));
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
   * On Enter and on the two acts that spend a result set (opening the editable
   * buffer, replacing), not on every search. The box searches as you type, so
   * recording each one would fill the list with `n`, `ne`, `nee`, `need` and
   * leave nothing worth arrowing through. Enter is the keystroke that already
   * means "this one", and it costs nothing in a box that has already searched.
   */
  function commitQuery() {
    const q = query();
    if (!q || !ws()) return;
    setHistory((h) => noteQuery(h, ws(), q, options(), restriction()));
    setCursor(DRAFT);
  }

  /** Put a past search back in the box, toggles and restriction and all, and
   *  run it. The stored repo paths are resolved against the members present
   *  now, so a recall from before a member was recreated still narrows to it. */
  function applyRecall(q: string, o: SearchOptions, repos: readonly string[] | undefined) {
    setQuery(q);
    setOptions({ ...o });
    setRestricted(resolveMemberRestriction(repos, allRoots()));
    // Debounced like typing rather than immediate like a toggle: holding Up
    // walks the list, and each step would otherwise be its own round trip.
    debouncedSearch(q);
  }

  function recall(step: 1 | -1) {
    const list = recallList();
    const from = cursor();
    if (from === DRAFT && step === 1) {
      draft = { query: query(), options: { ...options() }, repos: restriction() };
    }
    const to = stepRecall(list, from, step);
    if (to === from) return;
    setCursor(to);
    const entry = recallAt(list, to);
    if (entry) applyRecall(entry.query, entry.options, entry.repos);
    else applyRecall(draft.query, draft.options, draft.repos);
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
    setSaved((s) => saveSearch(s, ws(), name, query(), options(), restriction()));
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

  /**
   * Run a saved search and hand its hits straight to an editable buffer.
   *
   * Opening a saved search means arriving at the thing it names, and after
   * Phase 11 that thing is a buffer you can edit and write back, not a list to
   * click through. The panel is restored too, so the toggles on screen still
   * describe what you are looking at. A search that matches nothing opens no
   * tab: an empty buffer would be a tab to close rather than an answer.
   */
  async function openSaved(s: SavedSearch) {
    setCursor(DRAFT);
    setQuery(s.query);
    setOptions({ ...s.options });
    // Resolved here rather than read through the memo, so what is stored back
    // into the history is the same set the search is about to run against.
    const repos = resolveMemberRestriction(s.repos, allRoots());
    setRestricted(repos);
    setHistory((h) => noteQuery(h, ws(), s.query, s.options, repos));
    const fresh = await runSearch(s.query);
    if (!fresh) return;
    // Read off `fresh` rather than the signal, for the reason `runSearch`
    // returns it at all: the signal is only this search's answer if nothing
    // overtook it.
    const matches = fresh.flatMap((sec) => sec.matches.map((m) => ({ ...m, root: sec.root })));
    if (matches.length) {
      openSearchResults(ws(), s.query, matches, docRootsOf(fresh.map((sec) => sec.root)));
    }
  }

  // A toggle click is one deliberate act, not a keystroke, so it re-searches
  // immediately instead of waiting out the input debounce.
  function toggleOption(key: ToggleKey) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
    void runSearch(query());
  }

  /** Narrowing the search narrows what the toggles are judged against too: an
   *  option only the excluded member could not honour has to come back. With a
   *  query in the box the fresh search reports that; without one there is
   *  nothing to report it, so the probe answers instead. */
  function afterRestrictionChange() {
    if (query()) void runSearch(query());
    else void probeCapabilities();
  }

  /** Add or remove one member. Multi-select, and against the *resolved* set, so
   *  a stale entry from a saved search cannot survive the first click. */
  function toggleRestriction(repoPath: string) {
    const now = restriction();
    setRestricted(now.includes(repoPath) ? now.filter((p) => p !== repoPath) : [...now, repoPath]);
    afterRestrictionChange();
  }

  /** Back to every member. Clears the raw pick, not just the resolved one: a
   *  pick naming a member that has left resolves to nothing today and would
   *  otherwise come back the moment that member did, after All was pressed. */
  function clearRestriction() {
    const had = restriction().length;
    setRestricted([]);
    if (had) afterRestrictionChange();
  }

  function setGlob(key: "include" | "exclude", v: string) {
    setOptions((o) => ({ ...o, [key]: v }));
    debouncedGlobs();
  }

  // --- replace ---

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

  const dirtyPathsFor = (root: string) => dirtyRelativePaths(root, props.dirty ?? {});
  /** One root's replace targets, built from that root's own matches and its own
   *  digests. Keeping the fence per root is what stops a file that moved under
   *  one member from blocking a write to another. */
  const targetsFor = (s: SearchSection) => replaceTargets(s.matches, s.files, dirtyPathsFor(s.root));
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

  /** Why a file was skipped, phrased for the outcome line. Inside a Feature the
   *  reason alone is not actionable: two members routinely hold the same
   *  `src/index.ts`, so it has to say which one to go and deal with. */
  const skipReason = (root: string, reason: string) =>
    headed() ? `${reason} in ${labelFor(root)}` : reason;

  /** Apply each root's targets against that root, then report once and
   *  re-search. The re-search matters beyond freshness: it is what proves on
   *  screen that the write landed. */
  async function applyReplace(
    groups: RootTargets[],
    skippedForDirt: { root: string; path: string }[] = [],
  ) {
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
          options: options(),
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
    if (!groups.length || applying()) return;
    const occurrences = groups.reduce((n, g) => n + g.targets.reduce((m, t) => m + t.matches.length, 0), 0);
    const files = targetFileCount();
    const ok = props.confirm
      ? await props.confirm({
          title: `Replace ${occurrences} ${occurrences === 1 ? "occurrence" : "occurrences"} in ${files} ${files === 1 ? "file" : "files"}?`,
          message: "This writes to disk and cannot be undone from here.",
          confirmLabel: "Replace",
        })
      : true;
    if (!ok) return;
    const dirtyHits = sections().flatMap((s) =>
      dirtyPathsFor(s.root)
        .filter((p) => s.matches.some((m) => m.path === p))
        .map((path) => ({ root: s.root, path })),
    );
    await applyReplace(groups, dirtyHits);
  }

  function replaceFile(root: string, path: string) {
    const g = allTargets().find((x) => x.root === root);
    const targets = g?.targets.filter((t) => t.path === path) ?? [];
    if (targets.length) void applyReplace([{ root, targets }]);
  }

  function replaceOne(root: string, m: SearchMatch, span: Submatch) {
    const target = allTargets()
      .find((x) => x.root === root)
      ?.targets.find((t) => t.path === m.path);
    if (!target) return;
    void applyReplace([
      { root, targets: [{ ...target, matches: [{ line: m.line, start: span[0], end: span[1] }] }] },
    ]);
  }

  // Keyed on the member set and the workspace, deliberately not on `props.root`
  // (inside a Feature that is the *active member*, and clicking a Toolbar chip
  // to read another member's file must not spend a search that spans all of
  // them) and not on the searched set either, which the restriction moves.
  // A real workspace change moves both of these.
  createEffect(
    on(
      () => `${props.workspace ?? ""}${NUL}${membersKey()}`,
      () => {
        setSections([]);
        setError(null);
        // A restriction names members of the Feature you were in, so it means
        // nothing in the next one.
        setRestricted([]);
        // Everything below is scoped to a workspace, and none of it means
        // anything in the next one: a cursor indexes the history that was
        // there, and the draft it would restore is a query for the project you
        // just left. Carrying them over is how the first arrow press after a
        // switch puts someone else's half-typed text in the box.
        setCursor(DRAFT);
        draft = { query: "", options: { ...DEFAULT_SEARCH_OPTIONS }, repos: [] };
        setRenaming(null);
        setSaveName("");
        setSavedNotice(null);
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
    on([replacement, sections, showReplace], () => {
      if (showReplace()) debouncedPreview();
      else setPreview([]);
    }),
  );

  // A replace outcome describes one past action. Anything that changes what is
  // on screen retires it, so a success line can never sit above results it had
  // nothing to do with.
  createEffect(
    on(
      [query, options, rootsKey],
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

  function openMatch(root: string, path: string, line: number) {
    emitWith(OPEN_IN_EDITOR, { path: `${root}/${path}`, line });
  }

  /** Hand the current results to an editable buffer, as a tab. The matches go
   *  as they are: the buffer's whole claim is that each row is the line the
   *  search read, so re-deriving them here would give it a second answer to be
   *  wrong about. One tab for the whole set, keyed on the workspace: Open means
   *  "the results on screen", and a tab per member is a tab per member to close. */
  function openResultsBuffer() {
    if (!hitCount()) return;
    commitQuery();
    openSearchResults(ws(), query(), rootedMatches(), docRootsOf(sectionRoots().map((r) => r.path)));
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
      // one grep per member per burst, in exactly the Feature that has an agent
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
  const noticeFor = (s: SearchSection) =>
    truncationNotice(s.truncated, MAX_RESULTS, countOccurrences(s.matches));
  const hitCount = () => allMatches().length;

  return (
    <div class={styles.searchPanel}>
      <div class={styles.inputBar}>
        {/* Which members to search, and nothing else. Deliberately not wired to
            the Toolbar's active-member row: two chip rows on screen mean two
            different things, and narrowing a search must not also move which
            member the editor is showing. Multi-select, so "these two of five"
            is expressible; none selected means all, which is why All is a
            button rather than a chip you can also deselect into nothing. */}
        <Show when={headed()}>
          <div class={styles.memberRow} role="group" aria-label="Search these members">
            <Tooltip
              as="button"
              type="button"
              class={styles.memberChip}
              classList={{ [styles.memberOn]: !restriction().length }}
              aria-pressed={!restriction().length}
              label="Search every member of this Feature"
              onClick={clearRestriction}
            >
              All
            </Tooltip>
            <For each={allRoots()}>
              {(member) => {
                const unusable = () => member.state?.usable === false;
                const on = () => restriction().includes(member.repoPath);
                return (
                  <Tooltip
                    as="button"
                    type="button"
                    class={styles.memberChip}
                    classList={{ [styles.memberOn]: on() }}
                    style={member.tint ? { "--chip-hue": member.tint } : undefined}
                    // The initials are the visible label; the name is the
                    // accessible one, because "PA" announces as nothing.
                    aria-label={member.label}
                    aria-pressed={on()}
                    disabled={unusable()}
                    // Only the unusable chip needs it: it wraps the control in
                    // a hover surface, and the ordinary chip has no reason to
                    // carry that extra element.
                    whenDisabled={unusable()}
                    label={
                      unusable()
                        ? `${member.label}: ${member.state?.label}, nothing to search`
                        : `Search only ${member.label}`
                    }
                    onClick={() => toggleRestriction(member.repoPath)}
                  >
                    {memberInitials({ displayName: member.label, repoPath: member.repoPath })}
                  </Tooltip>
                );
              }}
            </For>
          </div>
        </Show>
        {/* The one swept site that does not become a `Tooltip`. This text
            describes the field rather than naming a control, and a tooltip on a
            text box opens on focus and then sits over the results for as long as
            you are typing into it - worse than the `title` it replaces. A
            description is what a screen reader announces on focus, which is
            more than the `title` ever did for a keyboard user. */}
        <input
          ref={inputEl}
          class={styles.searchInput}
          type="text"
          placeholder="Search project"
          aria-describedby={QUERY_HINT_ID}
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={onQueryKeyDown}
        />
        <span id={QUERY_HINT_ID} class={styles.srOnly}>
          Enter searches now and remembers the query; Up and Down walk what you have searched here
        </span>
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
              // The label is the answer to "why is this greyed out?", so it has
              // to survive the control being disabled.
              tooltipWhenDisabled
              tooltip={
                anyTruncated()
                  ? "Refine the search first: Replace All is disabled while results are capped"
                  : "Replace all"
              }
              // A capped result set is a subset of the real matches, so a
              // "replace everything" that silently means "replace the first 500"
              // is the one action that must not be offered here.
              disabled={anyTruncated() || !allTargets().length || applying()}
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
                  // Disabled means the backend cannot do it, and the label says
                  // which backend and why - unreachable exactly when it matters.
                  tooltipWhenDisabled
                  tooltip={off() ? `${t.label}. ${unsupportedReason(t.key, caps().backend)}` : t.label}
                  onClick={() => toggleOption(t.key)}
                />
              );
            }}
          </For>
          <span class={styles.toggleSpacer} />
          {/* Replace rewrites one pattern everywhere; this hands the same hits
              over as text and lets each one be edited on its own terms, which
              is the thing a regex cannot express. A capped result set is still
              offered here, unlike Replace All: the buffer writes back only the
              lines it is showing, so "the first 500" is exactly what it says. */}
          <IconButton
            size="xs"
            icon={<Icon icon={FilePen} size={14} />}
            aria-label="Edit results in a buffer"
            tooltipWhenDisabled
            tooltip="Edit results in a buffer and write them back"
            disabled={!hitCount()}
            onClick={openResultsBuffer}
          />
          <IconButton
            size="xs"
            icon={<Icon icon={Star} size={14} />}
            active={showSaved()}
            aria-label="Saved searches"
            tooltip="Saved searches"
            aria-expanded={showSaved()}
            aria-controls={SAVED_ID}
            onClick={() => setShowSaved((v) => !v)}
          />
          <IconButton
            size="xs"
            icon={<Icon icon={Replace} size={14} />}
            active={showReplace()}
            aria-label="Toggle replace"
            tooltip="Toggle replace"
            aria-expanded={showReplace()}
            onClick={() => setShowReplace((v) => !v)}
          />
          <IconButton
            size="xs"
            icon={<Icon icon={Ellipsis} size={14} />}
            active={showGlobs()}
            aria-label="Include and exclude globs"
            tooltip="Include and exclude globs"
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
            <Show
              when={savedList().length}
              fallback={<div class="tree-empty">No saved searches here yet</div>}
            >
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
                            label={`${s.query} - opens as an editable results buffer`}
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
                          // focus is asked for a frame after it is in the DOM -
                          // the same deferral the panel's own focus effect uses.
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
      </div>
      <Show when={error()}>
        <div class="tree-empty">{error()}</div>
      </Show>
      <Show when={!error() && !query()}>
        <div class="tree-empty">Type to search the project</div>
      </Show>
      <Show when={!error() && query() && !loading() && !hitCount()}>
        <div class="tree-empty">No matches</div>
      </Show>
      <Show when={outcome()}>
        <div class={styles.outcome}>{outcome()}</div>
      </Show>
      <div class={styles.results}>
        {/* Sections iterate over the roots, not over `sections()`: a member with
            no worktree never runs a grep and so has no result to iterate, yet it
            still needs a header to say why it is empty. */}
        <For each={sectionRoots()}>
          {(member) => {
            const found = () => sectionOf(member.path);
            const unusable = () => member.state?.usable === false;
            const files = () => groupByFile(found()?.matches ?? []);
            return (
              <div class={styles.section} data-root={member.path}>
                <Show when={headed()}>
                  <div class={styles.sectionHeader}>
                    <MemberChip
                      member={{ displayName: member.label, repoPath: member.repoPath }}
                      tint={member.tint}
                      decorative
                    />
                    <span class={styles.sectionName}>{member.label}</span>
                    <Show when={!unusable()}>
                      <span class={styles.matchCount}>{found()?.matches.length ?? 0}</span>
                    </Show>
                  </div>
                </Show>
                {/* Three ways a section says nothing was found, and they are not
                    the same answer: it could not be searched, it failed, or it
                    was searched and had no hits. */}
                <Show when={unusable()}>
                  <div class="tree-empty">{member.state?.label}: not searched</div>
                </Show>
                <Show when={found()?.error}>
                  <div class="tree-empty">{found()!.error}</div>
                </Show>
                <Show when={found() && noticeFor(found()!)}>
                  <div class={styles.truncatedNotice}>{noticeFor(found()!)}</div>
                </Show>
                <For each={files()}>
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
                            tooltip={`Replace in ${group.path}`}
                            disabled={dirtyPathsFor(member.path).includes(group.path) || applying()}
                            onClick={() => replaceFile(member.path, group.path)}
                          />
                        </Show>
                      </div>
                      <For each={group.matches}>
                        {(m) => (
                          <div
                            class={styles.matchRow}
                            onClick={() => openMatch(member.path, m.path, m.line)}
                          >
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
                                            tooltip="Replace this occurrence"
                                            disabled={
                                              dirtyPathsFor(member.path).includes(m.path) || applying()
                                            }
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              replaceOne(member.path, m, span);
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
            );
          }}
        </For>
      </div>
    </div>
  );
}
