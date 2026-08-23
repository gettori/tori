// What a tool's output turns out to be, read from the output itself.
//
// Pure and separate from the bodies that render it, because the questions worth
// testing here need no DOM: does a file whose own content starts with digits
// and a tab survive the gutter, does a 5000-hit result stop at the cap, and
// does an execute body that is really an ACP `rawOutput` object get read as one.

/** How many rows a list body renders before it offers the rest. A `Grep` can
 *  answer with thousands, and a transcript is not a results pane. */
export const BODY_ROWS = 200;

// Escape sequences a program wrote for a terminal that is not here. Two
// shapes: an OSC string (a window title, say) running to its terminator, and
// the CSI colours and cursor moves, which end at their final byte.
const ANSI =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|[\u001B\u009B][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * The output as pretty-printed JSON, or null when it is not JSON at all.
 *
 * ACP answers an execute call with its whole `rawOutput` object, so an ACP
 * command body is a JSON blob on one line where a Claude one is terminal
 * output. Rendering the blob as a terminal is what this is here to stop.
 *
 * A command that really did print JSON gets pretty-printed too. That is a
 * reformat of what it printed, and it is the trade taken knowingly: the
 * alternative is asking the tool's name which transport it came from, which is
 * the dispatch this whole plan removed.
 */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const value: unknown = JSON.parse(t);
    if (value === null || typeof value !== "object") return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/** One line of a file, and the line to open the editor at. */
export type ReadLine = { line: number; text: string };

// `cat -n`'s column: right-aligned digits, then one tab, then the line. Only
// the first tab belongs to the gutter.
const GUTTER = /^\s*(\d+)\t/;

/**
 * A read body's lines, with the file's own line numbers.
 *
 * Claude answers a `Read` with `cat -n` output, so the numbers are in the text
 * and have to come back out of it. `from` is what is left when they cannot be:
 * a cut landing inside a gutter, or a file that mimics one. It is the summary's
 * `from` where there is a summary, and 1 otherwise, which is every ACP read,
 * since no ACP payload fills a read summary.
 *
 * The gutter is only believed when **every** line carries one and they run
 * consecutively. A file whose own content is `12\thello` looks exactly like a
 * gutter one line at a time, and would be silently cut in half by a per-line
 * test.
 */
export function readLines(text: string, from: number): ReadLine[] {
  if (!text) return [];
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  const cut = raw.map((line) => GUTTER.exec(line));
  const first = cut[0] ? Number(cut[0][1]) : from;
  const numbered = cut.every((m, i) => m !== null && Number(m[1]) === first + i);
  if (!numbered) return raw.map((line, i) => ({ line: from + i, text: line }));
  return raw.map((line, i) => ({ line: first + i, text: line.slice(cut[i]![0].length) }));
}

/** One search hit: the file and line it came from where the output says, and
 *  the matched text. `path` is null for a line that names no file. */
export type HitRow = { path: string | null; line: number | null; text: string };

// `path:line:the matched text`. The path is non-greedy so a colon in the match
// itself cannot be mistaken for the separator.
const HIT = /^(.*?):(\d+):(.*)$/;

export function hitRows(text: string): HitRow[] {
  return lines(text).map((line) => {
    const m = HIT.exec(line);
    if (!m) return { path: null, line: null, text: line };
    return { path: m[1], line: Number(m[2]), text: m[3] };
  });
}

/** A path list body's entries. Blank lines are dropped: a path list is a list
 *  of paths, and an empty one is not an entry. */
export function pathRows(text: string): string[] {
  return lines(text).filter((line) => line.trim() !== "");
}

function lines(text: string): string[] {
  if (!text) return [];
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  return raw;
}
