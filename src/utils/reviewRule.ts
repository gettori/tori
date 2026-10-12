// What the review rule's session is told when its project sets no prompt of its
// own. It ends the way the autopilot brief expects a reviewer to, so an
// autopilot turned on mid-review can take the verdict over.
export const DEFAULT_REVIEW_PROMPT = `Review this pull request against its base branch. Read the change, run nothing that writes, and do not edit, commit, push or post anything.

Look for bugs, missed cases, risky changes and anything the description promises that the code does not do. Say what is fine as plainly as what is not.

End your last message with one JSON block {"event", "body", "comments"}. "event" is "approve", "comment" or "requestChanges". Each comment is {"path", "line", "side", "startLine", "startSide", "body"}, with "side" RIGHT for a line in the new file and LEFT for a removed one, "startLine" and "startSide" only for a range, and only on lines inside the diff.`;
