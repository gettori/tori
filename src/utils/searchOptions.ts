// Pure helpers behind the Search panel's toggles. The panel itself is a thin
// shell over these: anything with a decision in it lives here, where vitest can
// reach it, because there is no component-test agent in this repo.

/** Mirrors `SearchOptions` in `src-tauri/src/search.rs`. Field names are the
 *  wire names (the Rust struct is `rename_all = "camelCase"`), so the keys here
 *  double as the identifiers a backend reports in `unsupported`. */
export type SearchOptions = {
  case: boolean;
  regex: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  noIgnore: boolean;
};

/** UTF-16 code-unit offsets into a match's `text`, as the backend emits them. */
export type Submatch = [number, number];

/** One match, as `grep_project` reports it: a root-relative path, a 1-based
 *  line, that line's text, and the spans inside it. */
export type SearchMatch = { path: string; line: number; text: string; submatches: Submatch[] };

/** A file's size+mtime digest, the staleness guard a replace is fenced on. */
export type FileDigest = { path: string; digest: string };

/** What one `grep_project` call answers with. Here rather than in the panel
 *  because the merge below consumes it, and a shape the pure module cannot name
 *  is a shape its tests cannot build. */
export type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  /** Which backend ran: `rg`, `git` or `plain`. */
  backend: string;
  /** Option names this backend cannot honour, so a toggle never sits inert. */
  unsupported: string[];
  files: FileDigest[];
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  case: false,
  regex: false,
  wholeWord: false,
  include: "",
  exclude: "",
  noIgnore: false,
};

/** The toggles that are booleans, in the order the panel renders them. Also the
 *  exact strings a backend uses in `unsupported`, so the two cannot drift. */
export const TOGGLE_KEYS = ["case", "regex", "wholeWord", "noIgnore"] as const;
export type ToggleKey = (typeof TOGGLE_KEYS)[number];

/** Read a stored options record back, field by field, defaulting anything that
 *  is missing or of the wrong type.
 *
 *  Here rather than in either store because both `searchHistory` and
 *  `savedSearches` persist this shape, and a validator that lives next to one
 *  of them is a validator the other one drifts from. Field-by-field rather than
 *  a cast: this comes off `localStorage`, which is last session's schema at
 *  best, and a `regex: "yes"` reaching `grep_project` fails at the backend
 *  boundary instead of here. */
export function parseSearchOptions(raw: unknown): SearchOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const bool = (k: ToggleKey) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_SEARCH_OPTIONS[k]);
  const text = (k: "include" | "exclude") => (typeof o[k] === "string" ? (o[k] as string) : "");
  return {
    case: bool("case"),
    regex: bool("regex"),
    wholeWord: bool("wholeWord"),
    noIgnore: bool("noIgnore"),
    include: text("include"),
    exclude: text("exclude"),
  };
}

/** Shape the `grep_project` invoke payload. Kept here so the argument names are
 *  asserted by a test rather than only by a failing round-trip at runtime. */
export function grepArgs(root: string, query: string, options: SearchOptions, max: number) {
  return { root, query, options, max };
}

/** True when the backend that ran cannot honour `key`, so the panel should
 *  disable that toggle rather than let it sit there doing nothing. */
export function isUnsupported(unsupported: string[], key: ToggleKey): boolean {
  return unsupported.includes(key);
}

/** One root's leg of a fan-out: what it answered, or how it failed. A leg has
 *  one or the other, never both. */
export type RootOutcome = { root: string; result?: SearchResult | null; error?: string | null };

/** One member's worth of the merged result set. `error` is the only field that
 *  can be set with the rest empty: a member whose grep failed still gets a
 *  section, so its failure is reported where it happened rather than swallowing
 *  the members that succeeded. */
export type SearchSection = {
  root: string;
  matches: SearchMatch[];
  files: FileDigest[];
  truncated: boolean;
  backend: string;
  /** This root's own unsupported list, kept beside the union so a tooltip can
   *  name the backend that actually blocked the toggle. */
  unsupported: string[];
  error: string | null;
};

export type MergedSearch = {
  sections: SearchSection[];
  /** Every option no searched backend could honour. */
  unsupported: string[];
};

const EMPTY_SECTION = { matches: [], files: [], truncated: false, backend: "", unsupported: [] };

/** The options no backend in `results` can honour, in first-seen order.
 *
 *  A union rather than an intersection: a toggle that one member would silently
 *  ignore is a toggle whose result set would be a lie for that member, so it is
 *  disabled for all of them. Only the roots that answered contribute; a root
 *  that failed reported no capabilities to union in. */
export function unionUnsupported(results: (SearchResult | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    for (const key of r?.unsupported ?? []) if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Fold a fan-out into per-member sections plus the capability union.
 *
 *  Section order is the order the legs came in, which is member order: the
 *  panel's sections must not reshuffle because one member's grep was quicker.
 *  Truncation stays per section, since a cap reached in one repo says nothing
 *  about another. */
export function mergeSearchResults(entries: RootOutcome[]): MergedSearch {
  return {
    sections: entries.map(({ root, result, error }) => ({
      root,
      ...(result
        ? {
            matches: result.matches,
            files: result.files,
            truncated: result.truncated,
            backend: result.backend,
            unsupported: result.unsupported,
          }
        : EMPTY_SECTION),
      error: error ?? null,
    })),
    unsupported: unionUnsupported(entries.map((e) => e.result)),
  };
}

/** Total match spans across every result line. Distinct from the number of
 *  result rows: the cap counts matching *lines*, but one line can hold several
 *  occurrences, so a capped result set contains more occurrences than rows. */
export function countOccurrences(matches: { submatches: Submatch[] }[]): number {
  return matches.reduce((n, m) => n + m.submatches.length, 0);
}

/** The truncation notice, or null when nothing was dropped. Names both units,
 *  since "matches" alone reads as the row count while a replace acts on
 *  occurrences. */
export function truncationNotice(
  truncated: boolean,
  cap: number,
  occurrences: number,
): string | null {
  if (!truncated) return null;
  const plural = occurrences === 1 ? "occurrence" : "occurrences";
  return `First ${cap} matching lines shown (${occurrences} ${plural}). Refine your search.`;
}

/** The root-relative paths of files with unsaved edits, from the editor's
 *  absolute-keyed dirty record.
 *
 *  Two things it has to get right. `handleDirty` (`Editor.tsx`) sets entries to
 *  `false` rather than deleting them, so a falsy value is not a dirty file. And
 *  a plain `startsWith(root)` would treat `/proj-old/a.ts` as living inside
 *  `/proj`, so the boundary has to be a separator. */
export function dirtyRelativePaths(root: string, dirty: Record<string, boolean>): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const out: string[] = [];
  for (const [abs, isDirty] of Object.entries(dirty)) {
    if (!isDirty) continue;
    if (!abs.startsWith(`${base}/`)) continue;
    out.push(abs.slice(base.length + 1));
  }
  return out;
}

/** Split the panel's matches into the per-file targets `replace_in_files`
 *  takes, dropping any file with unsaved edits (its buffer, not the disk, is
 *  the version the user is looking at) and any file the search returned no
 *  digest for (there is nothing to prove it has not moved since). */
export function replaceTargets(
  matches: { path: string; line: number; submatches: Submatch[] }[],
  files: { path: string; digest: string }[],
  dirtyPaths: string[],
): { path: string; digest: string; matches: { line: number; start: number; end: number }[] }[] {
  const digests = new Map(files.map((f) => [f.path, f.digest]));
  const skip = new Set(dirtyPaths);
  const byPath = new Map<string, { line: number; start: number; end: number }[]>();
  for (const m of matches) {
    if (skip.has(m.path) || !digests.has(m.path)) continue;
    const spans = byPath.get(m.path) ?? [];
    for (const [start, end] of m.submatches) spans.push({ line: m.line, start, end });
    byPath.set(m.path, spans);
  }
  return [...byPath].map(([path, spans]) => ({
    path,
    digest: digests.get(path)!,
    matches: spans,
  }));
}

/** The sentence reporting what a replace did. Skips are grouped by reason so
 *  "unsaved changes" and "changed on disk" stay distinguishable, since they ask
 *  the user for different things. */
export function replaceOutcome(
  occurrences: number,
  changed: string[],
  skipped: { path: string; reason: string }[],
): string {
  const occ = `${occurrences} ${occurrences === 1 ? "occurrence" : "occurrences"}`;
  const files = `${changed.length} ${changed.length === 1 ? "file" : "files"}`;
  const parts = [`Replaced ${occ} in ${files}`];
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  for (const [reason, n] of byReason) parts.push(`${n} skipped (${reason})`);
  return `${parts.join(", ")}.`;
}

/** Why a toggle is disabled, phrased for a tooltip. The backend reports *that*
 *  it cannot honour an option; naming the reason is the panel's job, because a
 *  disabled control with no explanation is barely better than an inert one. */
export function unsupportedReason(key: ToggleKey, backend: string): string {
  if (key === "noIgnore" && backend === "plain") {
    return "Unavailable here: without ripgrep, and outside a git repo, there are no ignore rules to search past.";
  }
  return "Unavailable with the search backend running on this machine.";
}

export type Segment = { text: string; hit: boolean };

/** Split a result line into alternating plain and matched segments, so the
 *  panel can render highlights without doing offset arithmetic inline.
 *
 *  Defensive about the spans it is given: they are sorted, clamped to the
 *  string, and overlaps are merged. A malformed span should render the line
 *  plainly rather than throw or silently drop text, because `text` is the only
 *  copy of that line the panel has. */
export function splitHighlights(text: string, submatches: Submatch[]): Segment[] {
  const len = text.length;
  const spans = submatches
    .map(([s, e]) => [Math.max(0, Math.min(s, len)), Math.max(0, Math.min(e, len))] as Submatch)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const merged: Submatch[] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  if (!merged.length) return text ? [{ text, hit: false }] : [];

  const out: Segment[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < len) out.push({ text: text.slice(at), hit: false });
  return out;
}
