// What the Settings panel's header search found: which rows, and how many land
// in each tab.
//
// **Row granularity.** The filter was section-level until the tab strip landed,
// on the reasoning that a setting is understood through the ones around it and a
// lone checkbox under a heading is hard to act on. Per-tab count badges cannot
// be built on that: a badge saying how many *sections* a tab has some match in
// is not a number a user can check against what they see. The old rule's concern
// survives in where the rows are drawn - filtered rows keep their group headings
// around them - rather than in what the matcher returns.
//
// Lives here rather than in `utils/settingsCatalog.ts` because it imports
// `fuzzyScore`, and the catalogue is reachable from the terminal's chunk (see
// its module comment).
import { fuzzyScore } from "../../../utils/fuzzy";
import {
  SETTINGS,
  SETTING_TABS,
  TAB_OF_SECTION,
  type SettingEntry,
  type SettingTab,
} from "../../../utils/settingsCatalog";

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
 * The rows a query matches, and how many land in each tab.
 *
 * `null` for an empty query rather than "everything": the caller has to tell
 * "nothing typed" from "nothing matched", because the first renders the whole
 * panel and the second has to say that the filter found nothing, and a zeroed
 * record cannot express both.
 *
 * **Section and tab titles are not matched**, only row labels and hints. A title
 * has no row to count, so counting it would put a badge on a tab with nothing
 * highlighted under it. The sections whose controls only exist at runtime keep
 * their standing entry in the catalogue, so they are still found by name - and
 * counted once, as one entry, however many cards they draw.
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
