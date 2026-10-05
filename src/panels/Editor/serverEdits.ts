// What Tori does with a `WorkspaceEdit` a server pushes at it unasked.
//
// `workspace/applyEdit` is a **request**: the server is blocked until it gets an
// answer, and it usually sends one in the middle of executing a command the
// user is waiting on. That single fact decides everything here.
//
// **Nothing in this path may open a modal.** The interactive applier stops and
// asks before it saves a background buffer somebody has unsaved work in, which
// is right when a person just pressed a key and is looking at the screen. Here
// the same question would park the server on a dialog nobody has been given a
// reason to click, until its own timeout fires - and on rust-analyzer that
// timeout is ninety seconds. So the answer to "may I save this for you" is no,
// stated in the response, with a notice explaining why.
//
// **And the answer is owed promptly.** `applied: false` with a reason is a
// worse outcome for the edit and a far better one for the editor than a request
// that never comes back.

import {
  applyWorkspaceEdit,
  list,
  type ApplyDeps,
  type ApplyOutcome,
  type ApplyPolicy,
  type WorkspaceEdit,
} from "./workspaceEdit";

/** `workspace/applyEdit`'s params and its response, as the spec has them. */
export type ApplyEditParams = { label?: string; edit?: WorkspaceEdit };
export type ApplyEditResponse = { applied: boolean; failureReason?: string };

/**
 * What this module lets the client promise, and nothing beyond it.
 *
 * `applyEdit` because the router answers it. `workspaceEdit.documentChanges`
 * because `editsByUri` reads that shape.
 *
 * **`resourceOperations` is deliberately absent**, which the spec reads as "this
 * client supports none of them" - the truth, and the reason a conformant server
 * will not send one at all. `applyWorkspaceEdit`'s refusal is the backstop for
 * the servers that send them regardless, not the primary defence.
 *
 * `executeCommand` rides along because it is the other half of the same
 * exchange: a code action that arrives as a command is run with it, and the way
 * a server answers one is by pushing a `workspace/applyEdit` straight back.
 *
 * Nothing here invites dynamic registration or `workspace/configuration`. The
 * router answers only the methods it was given handlers for, and everything
 * else still gets the library's -32601 - so advertising more than this would be
 * the lie [[concept_lsp_capability_contract]] is about.
 */
export const workspaceEditClientCapabilities = {
  clientCapabilities: {
    workspace: {
      applyEdit: true,
      workspaceEdit: { documentChanges: true },
      executeCommand: {},
    },
  },
};

/**
 * How long a server is made to wait for its answer.
 *
 * Deliberately **not** the session's `request_timeout_ms`. That one is how long
 * *Tori* waits for a *server*, and it is sized for a cold rust-analyzer
 * indexing a cargo project (90s). This is how long a person waits for their
 * editor, which is a different question with a much smaller answer.
 */
export const APPLY_EDIT_TIMEOUT_MS = 2000;

const TOO_SLOW = "Tori took too long to apply this change, so nothing was changed.";

/**
 * The policy half: refuse where the interactive path would ask.
 *
 * No `precheck`, and no snapshot to take in `beforeWrite` - taking one is
 * itself a git operation that could outlast the deadline. What `beforeWrite`
 * does instead is the deadline's teeth, see `applyWithin`.
 */
export function serverEditPolicy(expired: () => boolean): ApplyPolicy {
  return {
    onDirty: (dirty) =>
      Promise.resolve(
        `${list(dirty)} ${dirty.length === 1 ? "has" : "have"} unsaved changes, and Tori will not save ${
          dirty.length === 1 ? "it" : "them"
        } on a language server's say-so, so nothing was changed.`,
      ),
    // The last gate before anything is written. Materialising a dozen files can
    // take longer than the deadline, and by then the answer is already on the
    // wire: writing now would leave the server certain nothing changed while
    // the tree says otherwise. Losing the race has to mean losing it entirely.
    beforeWrite: () => Promise.resolve(expired() ? TOO_SLOW : null),
  };
}

/**
 * Race the apply against the deadline, so a wedged apply cannot hold the server
 * open.
 *
 * The loser is not cancelled - a promise cannot be - so it is stopped
 * cooperatively instead: `expired` flips when the timer fires and the policy's
 * `beforeWrite` reads it. A late apply therefore aborts itself at the last gate
 * before the first byte, rather than writing files behind an `applied: false`
 * this function already returned.
 */
async function applyWithin(edit: WorkspaceEdit | undefined, deps: ApplyDeps, ms: number): Promise<ApplyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<ApplyOutcome>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve({ kind: "aborted", reason: TOO_SLOW });
    }, ms);
  });
  try {
    return await Promise.race([
      // Caught rather than left to reject: an unanswered request is the one
      // outcome this whole module exists to prevent.
      applyWorkspaceEdit(
        edit,
        deps,
        serverEditPolicy(() => expired),
      ).catch((e: unknown): ApplyOutcome => ({
        kind: "aborted",
        reason: `Tori could not apply this change: ${String(e)}`,
      })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answer one `workspace/applyEdit`.
 *
 * `deps` is null when no session can serve the edit, which is a real state: the
 * project was switched while the server was mid-command.
 */
export async function answerApplyEdit(
  params: unknown,
  deps: ApplyDeps | null,
  notify: (message: string) => void,
  timeoutMs: number = APPLY_EDIT_TIMEOUT_MS,
): Promise<ApplyEditResponse> {
  if (!deps) {
    const failureReason = "Tori has no editor session for this change, so nothing was changed.";
    notify(failureReason);
    return { applied: false, failureReason };
  }

  const outcome = await applyWithin((params as ApplyEditParams | null)?.edit, deps, timeoutMs);
  // An edit naming no file is a request that succeeded by having nothing to do,
  // not one that failed.
  if (outcome.kind !== "aborted") return { applied: true };
  notify(outcome.reason);
  return { applied: false, failureReason: outcome.reason };
}
