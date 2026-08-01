// Composing and splitting a commit message across the Changes panel's two
// fields, and the one question the amend toggle has to answer before it lets
// you rewrite history. Pure, so both can be tested without a repo or a mounted
// panel - the same reason `revertGuard.ts` and `prUrl.ts` sit out here.
import type { AheadBehind } from "./gitActions";

/** Join the panel's subject and body the way git reads them back: subject, one
 *  blank line, body. An empty body yields the subject alone rather than a
 *  message with trailing blank lines, so a one-line commit is still one line. */
export function composeCommitMessage(subject: string, body: string): string {
  const s = subject.trim();
  const b = body.trim();
  return b ? `${s}\n\n${b}` : s;
}

/** The inverse, for prefilling the fields from an existing message
 *  (`git_head_message`, i.e. `git log -1 --format=%B`). Everything after the
 *  *first* blank line is body, kept verbatim: a body with its own paragraph
 *  breaks has to survive the round trip, so only the first separator splits.
 *  A message with no blank line is all subject, which is what git's own
 *  subject/body split does. */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const text = message.replace(/\r\n/g, "\n").trim();
  const sep = text.indexOf("\n\n");
  if (sep === -1) return { subject: text, body: "" };
  return { subject: text.slice(0, sep).trim(), body: text.slice(sep + 2).trim() };
}

/** Would amending rewrite a commit the upstream already has?
 *
 *  `ahead === 0` with an upstream means HEAD is contained in it. No upstream
 *  means nothing to rewrite for anyone else, and unknown (the probe failed, or
 *  nothing is selected) reads as no.
 *
 *  This is deliberately a *warning* predicate, not a block: it reads the
 *  remote-tracking ref, which is only as fresh as the last fetch. A stale ref
 *  would otherwise forbid amending a commit that was never pushed, and the
 *  inverse (pushed elsewhere since the last fetch) is exactly the case a hard
 *  block would miss anyway. */
export function amendRewritesPushed(ab: AheadBehind | null): boolean {
  return !!ab && ab.has_upstream && ab.ahead === 0;
}
