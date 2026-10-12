// The issue source as the frontend sees it, mirrored from `src-tauri/src/issues`.
// A key is opaque (GitHub's is the number, Linear's would be `ENG-123`), and
// `display` is what goes on screen.

export type IssueKind = "issue" | "reviewRequest";

export type IssueRef = {
  key: string;
  display: string;
  title: string;
  url: string;
  kind: IssueKind;
  author?: string;
  headSha?: string;
};

export type ReviewRequests = { rows: IssueRef[]; complete: boolean };

export type Issue = {
  key: string;
  display: string;
  title: string;
  body: string;
  url: string;
  suggestedBranch: string;
};

export type LinkOutcome = "created" | "alreadyLinked" | "unlinked";

/** What a branch unit remembers about the issue it was started from. */
export type UnitIssue = {
  key: string;
  display: string;
  url: string;
  title: string;
};

/** The sentence out of whatever an issue command threw: a `ForgeErrorDto`
 *  carries it in `message`, anything else is its own text. */
export function errorText(e: unknown): string {
  return typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

export function unitIssueOf(issue: Issue): UnitIssue {
  return { key: issue.key, display: issue.display, url: issue.url, title: issue.title };
}

/** The first draft of a unit started from an issue: its title, then its body. */
export function issueDraft(issue: Issue): string {
  const body = issue.body.trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}

/** The review requests no branch here covers yet: none is `pr-<n>`, and none
 *  carries pull request `n`. */
export function pendingReviews(
  list: ReviewRequests | null,
  branches: readonly string[],
  prOf: (branch: string) => number | null,
): IssueRef[] {
  if (!list) return [];
  const covered = new Set<number>();
  for (const b of branches) {
    const own = /^pr-(\d+)$/.exec(b);
    if (own) covered.add(Number(own[1]));
    const n = prOf(b);
    if (n !== null) covered.add(n);
  }
  return list.rows.filter((r) => !covered.has(Number(r.key)));
}
