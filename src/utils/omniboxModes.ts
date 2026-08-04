// What the omnibox is looking at, decided by the first character of the query.
//
// One overlay with six modes rather than two overlays with three each. The
// prefixes are VS Code's, and the reason to copy them is not familiarity for its
// own sake: a prefix is a mode you can *type into*, so switching costs a
// keystroke inside the box rather than Escape, a second shortcut, and a lost
// query. That is also why this is a function of the query rather than a piece of
// state, since anything the box remembers separately from its text can disagree
// with it.
//
// Pure and free of imports, so the rule can be tested without a DOM and read
// without opening the component.

export type OmniMode = "file" | "command" | "doc" | "workspace" | "line" | "help";

export type ModeSpec = {
  mode: OmniMode;
  /** The character that selects it, or `""` for the mode with no prefix. */
  prefix: string;
  /** What this mode is called, for the help list. */
  label: string;
  /** What the input suggests while this mode is active. */
  placeholder: string;
};

/**
 * Every mode, in the order the `?` list shows them.
 *
 * The file mode is first and prefixless because it is what ⌘P has always opened
 * onto, and because "which file" is the question asked most often. The rest earn
 * a keystroke.
 */
export const MODES: ModeSpec[] = [
  { mode: "file", prefix: "", label: "Files", placeholder: "Go to file" },
  { mode: "command", prefix: ">", label: "Commands", placeholder: "Run an action" },
  { mode: "doc", prefix: "@", label: "Symbols in this file", placeholder: "Go to a symbol in this file" },
  { mode: "workspace", prefix: "#", label: "Symbols in the project", placeholder: "Search project symbols" },
  { mode: "line", prefix: ":", label: "Go to line", placeholder: "Go to line" },
  { mode: "help", prefix: "?", label: "What the prefixes do", placeholder: "The prefixes" },
];

export type Parsed = {
  mode: OmniMode;
  /** The query with its prefix removed and trimmed. */
  term: string;
};

/**
 * Which mode a raw query selects, and what is left to search with.
 *
 * The prefix is only read at position zero, so a `#` inside a filename is part
 * of the filename. Trimming the remainder makes `> save` behave as `>save`,
 * which matters because the prefix is typed and then the query is thought about.
 */
export function parseQuery(raw: string): Parsed {
  const spec = MODES.find((m) => m.prefix && raw.startsWith(m.prefix));
  if (!spec) return { mode: "file", term: raw.trim() };
  return { mode: spec.mode, term: raw.slice(spec.prefix.length).trim() };
}

/** The mode's spec, which every mode has. */
export function specOf(mode: OmniMode): ModeSpec {
  return MODES.find((m) => m.mode === mode)!;
}

/**
 * The line a `:` query names, or null when it names none.
 *
 * Only a plain positive integer counts. `:` with nothing after it is the mode
 * being entered rather than a request, and a jump to line 0 or to "12a" is a
 * typo rather than a destination: refusing both leaves the box saying what it
 * wants instead of silently landing somewhere.
 */
export function parseLine(term: string): number | null {
  if (!/^\d+$/.test(term)) return null;
  const n = Number(term);
  return n > 0 ? n : null;
}
