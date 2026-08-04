// Turning "which tags am I looking for" into a search, and the hits back into
// rows.
//
// The panel is a thin shell over this, the way the Search panel is over
// `searchOptions.ts`: the tags come from the three-layer settings resolution, so
// the interesting parts are what a tag list means when a user typed it by hand
// and how a `grep_project` hit becomes a row that names its tag. Both test
// without a DOM.

/** One tagged line, as the panel lists it. */
export type TodoItem = {
  /** Project-relative, as the backend reports it. */
  path: string;
  line: number;
  /** The tag that matched, taken from the hit itself rather than re-derived. */
  tag: string;
  /** The line, trimmed. A TODO is usually indented behind code, and a column of
   *  ragged leading whitespace in a narrow panel is unreadable. */
  text: string;
};

/** What `grep_project` hands back, narrowed to what this module reads. */
export type TodoMatch = {
  path: string;
  line: number;
  text: string;
  /** UTF-16 offsets into `text`, as the backend emits them. */
  submatches: [number, number][];
};

export type TodoGroup = { path: string; items: TodoItem[] };

/**
 * Split the setting into tags.
 *
 * Hand-typed, so it forgives what a person types: spaces around the commas,
 * a trailing one, the same tag twice. Empty entries are dropped rather than
 * kept as a tag matching everything, which is what an empty alternation branch
 * would do to the search.
 */
export function todoTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Escape a tag so it is matched as the text it is. Tags are labels, not
 *  patterns: someone writing `TODO(*)` means those characters, and a regex
 *  error there would break the panel rather than that one tag. */
function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The one regex that finds any of these tags.
 *
 * An alternation rather than a search per tag: the backend caps its results,
 * and N searches would each get their own cap and their own truncation, so a
 * repo full of TODOs could hide every FIXME behind them.
 *
 * No word boundaries. `\b` would stop `TODO` matching inside `TODOS`, which is
 * a rare and harmless over-match, but it would also break every tag that starts
 * with punctuation (`@todo` has no word boundary before the `@`), which is a
 * convention several codebases actually use.
 */
export function todoQuery(tags: string[]): string {
  return tags.map(escapeTag).join("|");
}

/**
 * Read the hits into rows.
 *
 * The tag comes out of the hit's own span rather than by testing each tag
 * against the line: the backend already decided what matched and where, and
 * asking the question again in JavaScript is how the row's label ends up
 * disagreeing with the reason the line is on screen at all.
 */
export function todoItems(matches: readonly TodoMatch[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const m of matches) {
    const span = m.submatches[0];
    if (!span) continue;
    const tag = m.text.slice(span[0], span[1]);
    if (!tag) continue;
    out.push({ path: m.path, line: m.line, tag, text: m.text.trim() });
  }
  return out;
}

/** Group by file, keeping the order the files were first reported in, which is
 *  the backend's order and so the same one the Search panel shows. */
export function groupTodos(items: readonly TodoItem[]): TodoGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, TodoItem[]>();
  for (const item of items) {
    if (!byPath.has(item.path)) {
      order.push(item.path);
      byPath.set(item.path, []);
    }
    byPath.get(item.path)!.push(item);
  }
  return order.map((path) => ({ path, items: byPath.get(path)! }));
}

/** How many of each tag, for the panel's filter chips. Every listed tag gets an
 *  entry, zero included, so a chip does not appear and vanish as a file is
 *  edited under it. */
export function tagCounts(items: readonly TodoItem[], tags: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tag of tags) counts[tag] = 0;
  for (const item of items) counts[item.tag] = (counts[item.tag] ?? 0) + 1;
  return counts;
}

/** The rows a chip selection leaves on screen. No selection means all of them,
 *  rather than none: an empty filter is the unfiltered state. */
export function filterByTags(items: readonly TodoItem[], selected: ReadonlySet<string>): TodoItem[] {
  return selected.size ? items.filter((i) => selected.has(i.tag)) : [...items];
}

/** What the panel says above the list.
 *
 *  The truncation half names the **cap**, not the count already on screen: the
 *  thing the user cannot see is that the project holds more than this, and
 *  repeating a number they are looking at tells them nothing. The cap is also
 *  the one figure a chip selection does not change, so the notice stays true
 *  while the list above it is filtered. */
export function todoSummary(
  items: readonly TodoItem[],
  files: number,
  truncated: boolean,
  cap = 0,
): string {
  const n = items.length;
  const head = `${n} ${n === 1 ? "item" : "items"} in ${files} ${files === 1 ? "file" : "files"}`;
  return truncated ? `${head} (capped at ${cap}, narrow the tags to see the rest)` : head;
}
