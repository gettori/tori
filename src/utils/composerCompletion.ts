// What the composer is completing at the caret, and how the candidates rank.
//
// One core for both menus. `@` completes a file out of the project index and
// resolves to an attachment chip; `/` completes a slash command out of the
// catalogue the `initialize` handshake returned and resolves to text. They
// differ in what they produce, not in how they are recognised, so the
// recognition lives here, pure, and each menu is a list plus a keydown.
import { insideFence } from "./composerFence";
import { fuzzyScore } from "./fuzzy";
import { traceWork } from "./perfTrace";

/** How many candidates a menu shows. Enough to scroll, few enough to scan. */
export const MAX_COMPLETIONS = 12;

export type CompletionKind = "file" | "command" | "pr";

export type CompletionToken = {
  kind: CompletionKind;
  /** What has been typed after the sigil, which is what gets fuzzy-matched. */
  query: string;
  /** Index of the sigil, and of the caret: the span an accepted completion
   *  replaces, so neither menu has to re-find its own trigger. */
  start: number;
  end: number;
};

/**
 * The completion token the caret sits in, or null.
 *
 * `@` triggers at a word boundary, because an email address or a decorator is
 * not a file mention. `/` triggers only at position 0: a slash command is the
 * whole message's opening, so completing one mid-sentence would offer to turn a
 * path like `src/utils` into a command.
 *
 * A token ends at the caret, never past it: typing into the middle of an already
 * accepted mention should not silently re-open a menu over it.
 */
export function activeToken(text: string, caret: number): CompletionToken | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));

  const at = before.lastIndexOf("@");
  const slash = before.lastIndexOf("/");
  const hash = before.lastIndexOf("#");

  const candidates: CompletionToken[] = [];
  if (at !== -1 && (at === 0 || /\s/.test(before[at - 1])) && !/\s/.test(before.slice(at + 1))) {
    candidates.push({ kind: "file", query: before.slice(at + 1), start: at, end: before.length });
  }
  // A `#` in a code block is a comment or a heading, never a pull request.
  if (
    hash !== -1 &&
    (hash === 0 || /\s/.test(before[hash - 1])) &&
    !/\s/.test(before.slice(hash + 1)) &&
    !insideFence(text, hash)
  ) {
    candidates.push({ kind: "pr", query: before.slice(hash + 1), start: hash, end: before.length });
  }
  if (slash === 0 && !/\s/.test(before.slice(1))) {
    candidates.push({ kind: "command", query: before.slice(1), start: 0, end: before.length });
  }
  // The one nearest the caret wins, so `/plan @sr` completes a file.
  return candidates.sort((a, b) => b.start - a.start)[0] ?? null;
}

/** Fuzzy-rank `items` against a query by the `text` each is matched on, best
 *  first, capped. An empty query keeps the source order, which for files is the
 *  project's own walk order and for commands is the catalogue's. */
export function rank<T>(items: readonly T[], query: string, textOf: (item: T) => string): T[] {
  const q = query.trim();
  if (!q) return items.slice(0, MAX_COMPLETIONS);
  return traceWork("fuzzy-composer", () => {
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
      const s = fuzzyScore(q, textOf(item));
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_COMPLETIONS).map((s) => s.item);
  });
}

/** Replace a token's span with `insert`, returning the new text and where the
 *  caret belongs after it. Used by the command menu; the file menu removes its
 *  token instead, since what it produces is a chip rather than text. */
export function replaceToken(text: string, token: CompletionToken, insert: string): { text: string; caret: number } {
  const next = `${text.slice(0, token.start)}${insert}${text.slice(token.end)}`;
  return { text: next, caret: token.start + insert.length };
}

/** Remove a token's span, for a completion whose result is not text. Collapses
 *  the space the mention was sitting in so removing `@src/a` from `see @src/a`
 *  does not leave a trailing double space. */
export function dropToken(text: string, token: CompletionToken): { text: string; caret: number } {
  const head = text.slice(0, token.start).replace(/\s+$/, "");
  const tail = text.slice(token.end);
  const joiner = head && tail && !/^\s/.test(tail) ? " " : "";
  return { text: `${head}${joiner}${tail}`, caret: head.length };
}

/** Move a menu's selection, wrapping at both ends. */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}
