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
};

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
