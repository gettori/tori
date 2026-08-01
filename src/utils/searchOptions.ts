// Pure helpers behind the Search panel's toggles. The panel itself is a thin
// shell over these: anything with a decision in it lives here, where vitest can
// reach it, because there is no component-test harness in this repo.

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
