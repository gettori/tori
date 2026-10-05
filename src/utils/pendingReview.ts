// A review held locally until it is submitted, and the two questions that
// decide what can be submitted at all.
//
// ## Why a review is held rather than posted comment by comment
//
// A review is atomic on the server: one call carries the verdict, the body and
// every line comment. Posting comments as they are written and the verdict at
// the end would leave a half-submitted review behind whenever the last call
// failed, with nothing saying which comments had already landed. So the draft
// lives here until the one call, and a failed submit hands the whole set back.
//
// ## Why the anchor is line-and-side
//
// A diff has two numberings, and they stop agreeing the moment anything above
// the line changed: line 12 of the base file is not line 12 of the head file.
// `line` alone is therefore ambiguous, and GitHub's older `position` (count of
// lines from the top of the patch) is worse, because it silently means a
// different line as soon as the pull request gets another commit.

import type { DiffRow } from "./diffView";
import type { DiffSide, DraftComment, PullRequest, ReviewEvent } from "./forgeTypes";

/** Which numbering a row is counted in. A removal exists only in the base file,
 *  everything else in the head file. */
export function rowSide(row: DiffRow): DiffSide {
  return row.kind === "del" ? "LEFT" : "RIGHT";
}

export type AnchorInput = {
  path: string;
  rows: readonly DiffRow[];
  /** Head-file line per row index, from `newSideLines`. */
  newLines: readonly (number | null)[];
  /** Base-file line per row index, from `oldSideLines`. */
  oldLines: readonly (number | null)[];
  /** Row indices the reader picked, in any order. */
  selected: readonly number[];
};

/** Turn a selection of rows into the anchor a comment carries.
 *
 *  The last selected row is the anchor and the first is the start of the range,
 *  which is GitHub's own convention. A selection spanning both sides is not a
 *  range the API can express as one comment, so it narrows to the anchor row
 *  alone rather than inventing a range across two numberings; the caller shows
 *  the resulting anchor, so the narrowing is visible rather than silent. */
export function anchorFor(input: AnchorInput): Omit<DraftComment, "body"> | null {
  const picked = [...input.selected].sort((a, b) => a - b);
  if (!picked.length) return null;
  const lineAt = (i: number): { line: number; side: DiffSide } | null => {
    const row = input.rows[i];
    if (!row) return null;
    const side = rowSide(row);
    const line = side === "LEFT" ? input.oldLines[i] : input.newLines[i];
    return line === null || line === undefined ? null : { line, side };
  };

  const last = lineAt(picked[picked.length - 1]);
  if (!last) return null;
  const first = lineAt(picked[0]);
  const ranged = first !== null && first.side === last.side && first.line < last.line;
  return {
    path: input.path,
    line: last.line,
    side: last.side,
    startLine: ranged ? first.line : null,
    startSide: ranged ? first.side : null,
  };
}

/** How an anchor reads to the person about to comment on it. Shown because the
 *  range can narrow (see `anchorFor`), and a silent narrowing is a comment that
 *  lands somewhere other than where it was drawn. */
export function anchorLabel(a: Omit<DraftComment, "body">): string {
  const side = a.side === "LEFT" ? " (base)" : "";
  return a.startLine !== null ? `${a.path}:${a.startLine}-${a.line}${side}` : `${a.path}:${a.line}${side}`;
}

/** Whether the signed-in account wrote this pull request.
 *
 *  Unknown until the viewer is known, and unknown must not read as "no": GitHub
 *  rejects approve and request-changes from the author with a 422, so guessing
 *  wrong offers a button that fails on click. */
export function isSelfAuthored(pr: PullRequest, viewerLogin: string | null): boolean | null {
  if (!viewerLogin) return null;
  return viewerLogin.toLowerCase() === pr.author.toLowerCase();
}

export type SubmitBlock = { event: ReviewEvent; reason: string };

export const STALE_ANCHOR_REASON = "Some comments no longer match the diff. Fix or remove them first.";
export const DRIFT_REASON = "This pull request has new commits. Reload the diff before submitting.";

/** Why the review cannot go out at all, whatever verdict it carries.
 *
 *  Separate from `submitBlock`, which answers per verdict from what the review
 *  says. These two are about the *diff underneath it*, so they refuse every
 *  verdict equally:
 *
 *    - **A stale or moved anchor.** `submit_review` sends no `commit_id`, so
 *      the server re-resolves each anchor against the diff it holds. A comment
 *      whose line no longer exists is refused outright; one whose line now
 *      reads differently is accepted and lands as a remark about whatever
 *      occupies it today, which is the worse half and the reason `moved` blocks
 *      as hard as `stale` does.
 *    - **Head drift.** The same failure, one level up: every anchor in hand was
 *      drawn against a commit that is no longer the head.
 *
 *  Refused rather than failed: a submit that throws away a review somebody
 *  spent an hour writing is not an error message, it is a loss. */
export function reviewBlock(input: { staleCount: number; drifted: boolean }): string | null {
  if (input.drifted) return DRIFT_REASON;
  if (input.staleCount > 0) return STALE_ANCHOR_REASON;
  return null;
}

/** Copy for each reason a verdict cannot be submitted. Separate from the check
 *  so the reason travels with the disabled control rather than being re-derived
 *  next to it. */
export const UNSUPPORTED_REASON = "This host has no such verdict.";
export const SELF_AUTHORED_REASON = "GitHub does not accept this on your own pull request.";
export const EMPTY_BODY_REASON = "Requesting changes needs a summary saying what to change.";

/** Why this verdict cannot be submitted right now, or null if it can.
 *
 *  Four independent noes, in the order they matter:
 *
 *    0. **The host has no such verdict.** GitLab has approve and comment and
 *       nothing that carries "changes requested", so the control is inert there
 *       for a reason that has nothing to do with this pull request.
 *    1. **Self-authored.** The server answers 422, so approve and
 *       request-changes are not offerable at all. `null` (viewer not yet known)
 *       blocks too: an unknown author is not a known-different one.
 *    2. **Request-changes with no body.** The verdict says something is wrong
 *       and the review says nothing about what. GitHub accepts it; a reader
 *       receiving it cannot act on it.
 *    3. **Nothing to say.** A comment review with neither a body nor a single
 *       line comment posts an empty review.
 */
export function submitBlock(input: {
  event: ReviewEvent;
  body: string;
  comments: readonly DraftComment[];
  selfAuthored: boolean | null;
  supported: boolean;
}): string | null {
  if (!input.supported) return UNSUPPORTED_REASON;
  const verdict = input.event === "approve" || input.event === "requestChanges";
  if (verdict && input.selfAuthored !== false) return SELF_AUTHORED_REASON;
  if (input.event === "requestChanges" && !input.body.trim()) return EMPTY_BODY_REASON;
  if (input.event === "comment" && !input.body.trim() && input.comments.length === 0) {
    return "Write a summary or leave a line comment first.";
  }
  return null;
}
