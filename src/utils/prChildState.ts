import type { UnitStatus } from "./forgeTypes";

export type PrChildState =
  | "noPr"
  | "draft"
  | "ready"
  | "commented"
  | "changesRequested"
  | "reReview"
  | "approved"
  | "reviewRequested"
  | "reviewed"
  | "merged"
  | "closed";

/** `unlaned` is someone else's PR that never asked you and that you never
 *  reviewed: a checkout of a colleague's branch, which no lane is about. */
export function prChildState(
  status: UnitStatus | null,
  viewer: string | null,
  reviewAsked: boolean,
): PrChildState | "unlaned" {
  const pr = status?.pullRequest;
  if (!status || !pr) return "noPr";
  const me = viewer?.toLowerCase() ?? null;
  const author = pr.author.toLowerCase();
  if (me !== null && author !== me) {
    const reviewedByMe = status.viewerReview !== null || status.reviews.some((r) => r.author.toLowerCase() === me);
    if (!reviewAsked && !reviewedByMe) return "unlaned";
    if (pr.state !== "open") return pr.state;
    return reviewAsked ? "reviewRequested" : "reviewed";
  }
  if (pr.state !== "open") return pr.state;
  if (pr.isDraft) return "draft";
  // The author replying in a thread files a review of their own.
  const others = status.reviews.filter((r) => r.author.toLowerCase() !== author);
  const asked = new Set(status.requestedReviewers.map((l) => l.toLowerCase()));
  const changes = others.filter((r) => r.verdict === "changesRequested");
  if (changes.some((r) => asked.has(r.author.toLowerCase()))) return "reReview";
  // `reviewDecision` is null on a repo with no review rule, so the verdicts
  // themselves are read too.
  if (changes.length > 0 || status.reviewDecision === "changesRequested") return "changesRequested";
  if (
    status.reviewDecision === "approved" ||
    (status.reviewDecision === "none" && others.some((r) => r.verdict === "approved"))
  )
    return "approved";
  return others.some((r) => r.verdict !== "dismissed") ? "commented" : "ready";
}
