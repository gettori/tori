// Pure and caret-based, not a property of the textarea, so a future editor
// surface (a CodeMirror composer) can ask the same question from a keymap.
// CommonMark fences: 3+ backticks or tildes after at most 3 spaces of indent.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// Closed only by the same character, a run at least as long, on its own line.
const CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Whether the caret sits inside an open fenced code block. */
export function insideFence(text: string, caret: number): boolean {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  let open: { char: string; length: number } | null = null;
  for (const line of before.split("\n")) {
    const opened = FENCE.exec(line);
    if (!opened) continue;
    const run = opened[1];
    if (!open) {
      open = { char: run[0], length: run.length };
      continue;
    }
    const closed = CLOSING.exec(line);
    if (closed && closed[1][0] === open.char && closed[1].length >= open.length) open = null;
  }
  return open !== null;
}
