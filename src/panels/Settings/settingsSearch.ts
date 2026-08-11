// What the Settings panel's filter box found, at two granularities.
//
// `matchingSections` is the older, section-level rule: a setting is understood
// through the ones around it, so a match keeps its neighbours on screen.
// `matchingEntries` is row-level, which the per-tab count badges need - a badge
// counting *sections* is not a number the user can check against what they see.
// Each function's own comment carries the reasoning; they coexist deliberately
// while the panel moves from one to the other.
//
// Both live here rather than in `utils/settingsCatalog.ts` because they import
// `fuzzyScore`, and the catalogue is reachable from the terminal's chunk (see
// its module comment).
import { fuzzyScore } from "../../utils/fuzzy";
import {
  SECTION_TITLES,
  SETTINGS,
  SETTING_TABS,
  TAB_OF_SECTION,
  type SettingEntry,
  type SettingSection,
  type SettingTab,
} from "../../utils/settingsCatalog";

/**
 * Labels are matched as a subsequence, hints as a substring.
 *
 * The two rules differ because the strings do. `fuzzyScore` is what the palette
 * and Cmd+P use, and it earns its looseness on a short label: "sfw" finding
 * "Soft wrap long lines" is the point. Run against a two-sentence hint that
 * looseness costs the filter its meaning, since almost any query is a
 * subsequence of a hundred characters of prose, so a hint has to be quoted
 * rather than guessed at.
 */
function matchesHint(hint: string | undefined, query: string): boolean {
  return !!hint && hint.toLowerCase().includes(query.toLowerCase());
}

/**
 * The sections a query leaves visible, or `null` for an empty query.
 *
 * `null` rather than "all of them" so the caller can tell "nothing typed" from
 * "nothing matched": the first renders the whole panel, the second has to say
 * that the filter found nothing, and a full set cannot express both.
 */
export function matchingSections(query: string): Set<SettingSection> | null {
  const q = query.trim();
  if (!q) return null;
  const hit = new Set<SettingSection>();
  for (const [id, title] of Object.entries(SECTION_TITLES)) {
    if (fuzzyScore(q, title) !== null) hit.add(id as SettingSection);
  }
  for (const s of SETTINGS) {
    if (hit.has(s.section)) continue;
    if (fuzzyScore(q, s.label) !== null || matchesHint(s.hint, q)) hit.add(s.section);
  }
  return hit;
}

/** Whether one catalogue entry answers a query: its label loosely, its hint
 *  quoted. The same two fields and the same two rules the palette uses, so a
 *  query that finds a `Preferences:` command finds the row it opens. */
function matchesEntry(entry: SettingEntry, query: string): boolean {
  return fuzzyScore(query, entry.label) !== null || matchesHint(entry.hint, query);
}

/** What a query found, per row and per tab. */
export type RowMatches = {
  /** The ids of the entries that matched, for the pane to filter and highlight
   *  by. A `Set` because the pane asks about one row at a time. */
  ids: Set<string>;
  /** Matches per tab, **every** tab present including the zeroes: the strip
   *  dims a zero-match tab rather than hiding it, and it needs a number to
   *  render, not a missing key. */
  counts: Record<SettingTab, number>;
  /** Matches across every tab, which is what the "N elsewhere" empty state and
   *  the aria-live announcement count. */
  total: number;
};

/**
 * The rows a query matches, and how many land in each tab. `null` for an empty
 * query, for `matchingSections`' reason: "nothing typed" renders the whole panel
 * and "nothing matched" has to say so, and a zeroed record cannot express both.
 *
 * **Row granularity, unlike `matchingSections` above, and deliberately so.** The
 * section-level rule exists because a lone checkbox under a heading with its
 * neighbours hidden is hard to act on. Per-tab counts cannot be built on it: a
 * badge saying how many *sections* a tab has some match in is not a number a
 * user can check against what they see. The rows stay in a filtered pane with
 * their section headings around them, which is how the reason behind the older
 * rule is kept while the granularity changes.
 *
 * **Section and tab titles are not matched**, again unlike `matchingSections`.
 * A title has no row to count, so counting it would put a badge on a tab with
 * nothing highlighted under it. The sections whose controls only exist at
 * runtime keep their standing entry in the catalogue, so they are still found
 * by name - and counted once, as one entry, however many cards they draw.
 */
export function matchingEntries(query: string): RowMatches | null {
  const q = query.trim();
  if (!q) return null;
  const counts = Object.fromEntries(SETTING_TABS.map((t) => [t.id, 0])) as Record<SettingTab, number>;
  const ids = new Set<string>();
  for (const entry of SETTINGS) {
    if (!matchesEntry(entry, q)) continue;
    ids.add(entry.id);
    counts[TAB_OF_SECTION[entry.section]] += 1;
  }
  return { ids, counts, total: ids.size };
}
