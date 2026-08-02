// "Hand this review comment to the agent that wrote the branch" (plan phase 12).
//
// A review thread is a question about one specific place in the code, and the
// session that made that place is the one that can answer it. This turns the
// thread into the single line safe-send carries, so the remark reaches the agent
// with its location, its wording and its argument intact rather than as a
// paraphrase the reviewer never wrote.
//
// **Single-line by construction, not by trimming.** `sanitizeForSend` flattens
// whatever it is given, so a composer whose output changes when it is sanitised
// would have a golden fixture recording text the agent never sees. Every body is
// flattened here, and the fixture asserts the round trip.
//
// The message deliberately stops at the code. Replying and resolving are done
// from Sway, over an authenticated API with an optimistic card behind it; an
// agent told to "reply on GitHub" would reach for whatever CLI it has and write
// as the account, outside every guard Phase 10 put on that write.

import { mentionPath } from "./pathScope";
import type { ReviewThread } from "./forgeTypes";
import { sanitizeForSend, type SessionTarget } from "./safeSend";

/** How many replies the message quotes before it stops. A thread thirty deep
 *  would otherwise paste an entire argument into the prompt. What is left out
 *  is counted rather than dropped in silence. */
export const REPLY_CAP = 4;

/** One body as a single line, through the send path's own rule rather than a
 *  second copy of it: what the fixture records is then exactly what the agent
 *  receives, hostile bodies included. Never truncated, because the body *is* the
 *  request being passed on and a review comment cut off mid-sentence is one
 *  whose point went missing. Only the number of replies is capped. */
const flat = sanitizeForSend;

/// Where in the file the thread sits, in terms the agent can act on.
///
/// Three cases, and only the first is a plain line number. A thread carries
/// `startLine` because Sway itself sends ranges, so reporting `line` alone would
/// narrow a range this app had written. `isOutdated` with a line still set is
/// the sharp one: the number is real but counts against the commit the comment
/// was written on, so an agent told the bare number would edit the wrong place
/// and be confident about it.
export function threadWhere(thread: ReviewThread): string {
  if (thread.line === null) return "on lines that have changed since it was written";
  const start = thread.startLine;
  const range =
    start !== null && start !== thread.line
      ? `lines ${start}-${thread.line}`
      : `line ${thread.line}`;
  return thread.isOutdated ? `${range} as the file then stood` : range;
}

/**
 * The wire format for "look at this review comment".
 *
 * `root` is the **owning unit's folder**, not whichever directory the panel
 * happens to be showing: a worktree project's units each have their own
 * checkout, and a path resolved against the wrong one mentions a file the agent
 * cannot open. Relativity then follows the drag-mention convention like every
 * other composer here (inside the target's cwd, relative; outside it, absolute).
 */
export function composeThreadAsk(
  target: SessionTarget,
  root: string,
  number: number,
  thread: ReviewThread,
): string {
  const cwd = target.sessionCwd || target.folderPath;
  const mention = mentionPath(`${root.replace(/\/+$/, "")}/${thread.path}`, cwd);
  const lead = thread.isResolved ? "Resolved review comment" : "Review comment";
  const head =
    thread.line === null
      ? `${lead} on @${mention} (PR #${number}), ${threadWhere(thread)}.`
      : `${lead} on @${mention} ${threadWhere(thread)} (PR #${number}).`;

  const [first, ...replies] = thread.comments;
  const opening = first ? ` ${first.author} wrote: "${flat(first.body)}".` : "";
  const quoted = replies.slice(0, REPLY_CAP).map((c) => `${c.author}: "${flat(c.body)}"`);
  const more = replies.length - quoted.length;
  const rest = more ? ` (and ${more} more ${more === 1 ? "reply" : "replies"})` : "";
  const tail = quoted.length ? ` Then ${quoted.join("; ")}${rest}.` : "";

  return `${head}${opening}${tail} Make the change here; the reply on GitHub is sent from Sway.`;
}
