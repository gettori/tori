// The line a pull request says about itself above its diff: who opened it, when,
// when it last moved, and how big it is.
//
// One builder for the panel and for the pull request's own tab. The two draw
// the same sentence a column apart, and a reader crossing between them should
// not have to work out which of two wordings they are looking at.

import { compactAgo } from "./compactAge";
import type { PrCounts, PullRequest } from "./forgeTypes";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "opened 3d ago", or null when the host sent a date that does not parse. */
export function prOpened(pr: PullRequest): string | null {
  const opened = Date.parse(pr.createdAt);
  return Number.isNaN(opened) ? null : `opened ${compactAgo(opened / 1000)}`;
}

/** What the detail read adds: when it last moved, and how big it is. `files`
 *  off for a surface whose own file list already counts them. */
export function prActivity(updatedAt: string | null, counts: PrCounts | null, files = true): string[] {
  const parts: string[] = [];
  const moved = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isNaN(moved)) parts.push(`updated ${compactAgo(moved / 1000)}`);
  if (counts) parts.push(plural(counts.commits, "commit"));
  if (counts && files) parts.push(plural(counts.changedFiles, "file"));
  return parts;
}
