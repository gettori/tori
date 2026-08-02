// Where a review thread belongs in a rendered diff, and when the honest answer
// is "nowhere".
//
// A thread carries a path and a line **in the pull request's head file**. The
// diff on screen is a list of hunks, each a run of lines with its own new-side
// starting number. Putting a thread on a row therefore means answering two
// questions, and getting either wrong is worse than showing nothing:
//
//   1. **Is this thread's anchor still meaningful?** GitHub says so with two
//      fields, and they disagree on purpose. `line` goes null when the anchor
//      cannot be expressed against the current diff at all; `isOutdated` says
//      the thread was written against an older version of the file, which can
//      be true while `line` still holds a number. That number describes a file
//      that has since changed, so trusting it puts a three-week-old "this leaks
//      a handle" beside whatever occupies that line today.
//   2. **Which row is that line?** Only rows that exist on the new side have
//      one. A deletion is not in the head file, so it has no head-file line,
//      and counting it would shift every line after it in the hunk.
//
// So: a thread anchors only when it is current *and* names a line the diff
// actually renders. Everything else goes to the outdated group, where the quote
// of the hunk it was written against is the whole of what makes it readable.

import type { ReviewComment, ReviewThread } from "./forgeTypes";

/** Whether this thread's line number still describes the diff on screen.
 *
 *  Both conditions, not either. A null line cannot be placed at all; a line on
 *  an outdated thread can be placed and would be placed wrongly, which is the
 *  more expensive of the two mistakes because it looks right. */
export function isAnchored(t: ReviewThread): boolean {
  return t.line !== null && !t.isOutdated;
}

/** New-side (head file) line number for each line of a hunk body, index-aligned
 *  with the rows `buildRows` produces, and null where a line has none.
 *
 *  Index alignment holds because `buildRows` emits one row per input line in
 *  order: a unified diff already groups a change block's removals before its
 *  additions, which is the order the row builder re-emits them in.
 *
 *  Deletions and the `\ No newline` marker get null: neither is in the head
 *  file, and numbering them would push every following line one out of step. */
export function newSideLines(hunk: { startLine: number; lines: string[] }): (number | null)[] {
  let next = hunk.startLine;
  return hunk.lines.map((line) => {
    if (line.startsWith("-") || line.startsWith("\\")) return null;
    return next++;
  });
}

/** Marks a comment that exists only on screen so far.
 *
 *  A prefix on the id rather than a flag beside it, because the id is what every
 *  keyed list and every reconcile already looks the comment up by, and a second
 *  field is a second thing that can be forgotten at one of those call sites. It
 *  cannot collide: a GitHub node id is base64 and never contains a colon. */
export const PENDING_PREFIX = "pending:";

export function isPending(c: ReviewComment): boolean {
  return c.id.startsWith(PENDING_PREFIX);
}

/** The comment to show the instant a reply is sent.
 *
 *  Its author is "you" and not the signed-in login on purpose: the login would
 *  make it indistinguishable from a comment the server has actually stored, and
 *  the one thing this comment needs to say is that it has not been. */
export function pendingComment(body: string, seq: number): ReviewComment {
  return { id: `${PENDING_PREFIX}${seq}`, author: "you", body, createdAt: "" };
}

/** Add a comment to one thread, or swap it for one already there.
 *
 *  Both halves of an optimistic reply, in one function, because they have to
 *  agree on where in the list the comment sits: an append-then-replace that
 *  reconciled by pushing again would show the reply twice, and the version that
 *  looks correct (drop the pending one, append the real one) reorders the thread
 *  whenever two replies are in flight. */
export function withComment(
  threads: readonly ReviewThread[],
  threadId: string,
  comment: ReviewComment,
  replacingId?: string,
): ReviewThread[] {
  return threads.map((t) => {
    if (t.id !== threadId) return t;
    const at = replacingId === undefined ? -1 : t.comments.findIndex((c) => c.id === replacingId);
    if (at < 0) return { ...t, comments: [...t.comments, comment] };
    const comments = [...t.comments];
    comments[at] = comment;
    return { ...t, comments };
  });
}

/** Take a comment back out, for a reply the server refused. */
export function withoutComment(
  threads: readonly ReviewThread[],
  threadId: string,
  commentId: string,
): ReviewThread[] {
  return threads.map((t) =>
    t.id === threadId ? { ...t, comments: t.comments.filter((c) => c.id !== commentId) } : t,
  );
}

/** Set one thread's resolved flag. */
export function withResolved(
  threads: readonly ReviewThread[],
  threadId: string,
  resolved: boolean,
): ReviewThread[] {
  return threads.map((t) => (t.id === threadId ? { ...t, isResolved: resolved } : t));
}

export type GroupedThreads = {
  /** Anchored threads, by path then by head-file line. */
  byLine: Map<string, Map<number, ReviewThread[]>>;
  /** Everything that could not be placed, in the order the server sent it. */
  outdated: ReviewThread[];
};

/** Split threads into the ones a diff row can carry and the ones it cannot. */
export function groupThreads(threads: readonly ReviewThread[]): GroupedThreads {
  const byLine = new Map<string, Map<number, ReviewThread[]>>();
  const outdated: ReviewThread[] = [];
  for (const t of threads) {
    if (!isAnchored(t)) {
      outdated.push(t);
      continue;
    }
    let file = byLine.get(t.path);
    if (!file) {
      file = new Map();
      byLine.set(t.path, file);
    }
    const at = file.get(t.line!);
    if (at) at.push(t);
    else file.set(t.line!, [t]);
  }
  return { byLine, outdated };
}

/** The threads a file's rendered hunks can actually show, and the ones that
 *  belong to that file but land on no rendered line.
 *
 *  The second list is not the same as outdated. A thread can be perfectly
 *  current and still miss every row: its line sits in a stretch of the file the
 *  patch does not cover, or the file's patch was withheld entirely. Dropping
 *  those silently is how a review conversation disappears from a file that
 *  visibly has one. */
export function splitByRenderedLines(
  forFile: Map<number, ReviewThread[]> | undefined,
  renderedLines: readonly (number | null)[],
): { shown: Map<number, ReviewThread[]>; offDiff: ReviewThread[] } {
  const shown = new Map<number, ReviewThread[]>();
  const offDiff: ReviewThread[] = [];
  if (!forFile) return { shown, offDiff };
  const rendered = new Set(renderedLines.filter((l): l is number => l !== null));
  for (const [line, threads] of forFile) {
    if (rendered.has(line)) shown.set(line, threads);
    else offDiff.push(...threads);
  }
  return { shown, offDiff };
}
