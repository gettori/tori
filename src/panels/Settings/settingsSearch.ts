// Which sections the Settings panel's filter box leaves on screen.
//
// Section granularity, not row: a setting is understood through the ones around
// it, and a lone checkbox floating under a heading with its neighbours hidden is
// harder to act on than a section with one obvious match in it. It also keeps
// the hand-written rows and the generated ones behaving the same way, which a
// row-level filter could not without every section becoming data first.
//
// Lives here rather than in `utils/settingsCatalog.ts` because it imports
// `fuzzyScore`, and the catalogue is reachable from the terminal's chunk (see
// its module comment).
import { fuzzyScore } from "../../utils/fuzzy";
import { SECTION_TITLES, SETTINGS, type SettingSection } from "../../utils/settingsCatalog";

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
