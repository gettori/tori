// The omnibox's mode comes from the query's first character, and from the key
// that opened the box when there is no prefix. That home never changes while
// the box is up. Free of imports, so the rule is testable without a DOM.

export type OmniMode = "all" | "file" | "command" | "doc" | "workspace" | "line" | "help";

export type OmniHome = "all" | "file";

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
 * `all` is the one mode without a prefix: it is where Cmd+K lands, and a prefix
 * is how you leave it. Files take `/` so they stay a keystroke away from there,
 * while Cmd+P opens on them with nothing typed.
 */
export const MODES: ModeSpec[] = [
  { mode: "all", prefix: "", label: "Everything", placeholder: "Go to anything, or run a command" },
  { mode: "file", prefix: "/", label: "Files", placeholder: "Go to file" },
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
 * A query with no prefix selects `home`. The prefix is only read at position
 * zero, so a `#` inside a filename is part of the filename. Trimming the
 * remainder makes `> save` behave as `>save`, which matters because the prefix
 * is typed and then the query is thought about.
 */
export function parseQuery(raw: string, home: OmniHome): Parsed {
  const spec = MODES.find((m) => m.prefix && raw.startsWith(m.prefix));
  if (!spec) return { mode: home, term: raw.trim() };
  return { mode: spec.mode, term: raw.slice(spec.prefix.length).trim() };
}

/** The mode's spec, which every mode has. */
export function specOf(mode: OmniMode): ModeSpec {
  return MODES.find((m) => m.mode === mode)!;
}

/**
 * The modes a box opened on `home` can be typed into, for the `?` list.
 *
 * The home's own mode leads and takes no prefix there, whatever `MODES` gives
 * it. `all` has none to type, so a box opened on files does not list it.
 */
export function modesFrom(home: OmniHome): ModeSpec[] {
  const typed = MODES.filter((m) => m.prefix && m.mode !== home && m.mode !== "help");
  return [{ ...specOf(home), prefix: "" }, ...typed];
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
