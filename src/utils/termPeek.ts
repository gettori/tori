// Tab peek: the last few lines of a background terminal's buffer, for the
// hover popover on the terminal tab strip.
//
// The buffer lives inside a mounted xterm, which only `TerminalView` holds, so
// each view registers a reader here on mount and drops it on cleanup. A tab
// with no entry has no mounted buffer (a restored tab that has never been
// focused), which is a *defined* state the popover renders as "no output yet",
// distinct from a mounted-but-empty buffer.

// ESC[ ... final-byte (CSI/SGR), and OSC strings terminated by BEL or ST.
// SerializeAddon emits both; the popover is plain text, so they all go.
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "");
}

// The last `max` non-empty lines of a serialized buffer, oldest first. Blank
// lines are dropped rather than counted: a TUI's alt-screen serializes as a
// full-height frame that is mostly padding, so counting them would return a box
// of whitespace instead of the output someone hovered to see.
export function tailLines(serialized: string, max: number): string[] {
  const lines = stripAnsi(serialized)
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trimEnd())
    .filter((l) => l.trim() !== "");
  return lines.slice(Math.max(0, lines.length - max));
}

type PeekReader = () => string;
const readers = new Map<string, PeekReader>();

// Called by TerminalView on mount; the returned function unregisters it.
export function registerPeek(id: string, read: PeekReader): () => void {
  readers.set(id, read);
  return () => {
    // Only drop our own entry: a re-registration under the same id (a remounted
    // view) must not be unregistered by the old view's cleanup.
    if (readers.get(id) === read) readers.delete(id);
  };
}

// Null when the tab has no mounted buffer at all; an empty array when it has
// one that has produced nothing yet. The popover distinguishes the two.
export function peekTab(id: string, max = 10): string[] | null {
  const read = readers.get(id);
  if (!read) return null;
  try {
    return tailLines(read(), max);
  } catch {
    return null;
  }
}
