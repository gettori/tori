// The question asked before anything rewrites a whole worktree.
//
// Discard-all and every stash action share one hazard: each rewrites files
// across the worktree, so an agent mid-turn there can have its work clobbered
// or clobber the change a moment later. Two surfaces reach them now (the
// Changes panel and the palette), which is two places for the guard to be
// forgotten, so the check lives here instead of in either of them.

import { folderActors } from "./folderActors";
import { revertGuard } from "./revertGuard";

/** What the caller supplies: the confirm dialog it already owns, and a way to
 *  say no. Structural rather than a component's props, so a util does not
 *  depend on a panel. */
export type GuardAsk = {
  confirm: (opts: { title: string; message: string; confirmLabel: string; danger: boolean }) => Promise<boolean>;
  refuse: (reason: string) => void;
};

/**
 * Whether a worktree-wide rewrite may go ahead.
 *
 * Two tiers, the same as a tree revert: a session verifiably Executing blocks
 * hard, one Tori cannot see inside is overridable. `verb` names the action in
 * the override, so the question reads as itself rather than as a revert.
 */
export async function mayRewrite(verb: string, root: string, ask: GuardAsk): Promise<boolean> {
  const candidates = await folderActors(root);
  const verdict = revertGuard(candidates, { folderPath: root });
  if (verdict.allow) return true;
  if (!verdict.overridable) {
    ask.refuse(verdict.reason);
    return false;
  }
  const go = await ask.confirm({
    title: "Another session may be running here",
    message: `${verdict.reason}\n\n${verb} anyway?`,
    confirmLabel: `${verb} anyway`,
    danger: true,
  });
  if (!go) return false;
  // Re-read rather than trusting the first verdict: the override is about the
  // sessions Tori cannot see inside, and a session that became visibly busy
  // while the dialog was open is no longer one of them.
  return revertGuard(candidates, { folderPath: root, allowDetached: true }).allow;
}
