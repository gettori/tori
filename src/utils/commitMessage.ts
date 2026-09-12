// The one question the amend toggle has to answer before it lets you rewrite
// history. Pure, so it can be tested without a repo or a mounted panel - the
// same reason `revertGuard.ts` and `prUrl.ts` sit out here.
import type { AheadBehind } from "./gitActions";

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
