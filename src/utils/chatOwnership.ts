// How a session-ownership refusal is described and what can be done about it.
//
// One session id has exactly one owner, measured: two `claude --resume` on one
// id both succeed, both append to one transcript, and the file ends up recording
// a conversation that never happened. So the second opener is refused - by the
// chat host and by the PTY host alike.
//
// A refusal is a *value* on both paths (`chat_spawn`'s `SpawnResult.ownership`,
// `pty_spawn`'s `PtySpawnResult.ownership`), never an error string, because the
// only useful responses are structural: go to the tab that holds the session, or
// end the leftover process that does. Neither can be offered from a message.
//
// The wording lives here rather than in either panel so a refusal reads the same
// whichever surface hit it, and so it can be tested without mounting anything.

/** `ClaimOutcome` from `src-tauri/src/chat/ownership.rs`. */
export type ClaimOutcome =
  | { type: "granted"; contested: boolean }
  | { type: "alreadyMineFocus"; tabId: string }
  | { type: "heldByOther"; surface: "chat" | "ptyAgent"; tabId: string }
  | { type: "orphaned"; childPid: number };

/** A refused claim: everything except a grant. */
export type Refusal = Exclude<ClaimOutcome, { type: "granted" }>;

export function refusalOf(outcome: ClaimOutcome | null | undefined): Refusal | null {
  return outcome && outcome.type !== "granted" ? outcome : null;
}

/** The tab holding this session, when a tab is what holds it. An orphan is a
 *  bare process, so there is nothing to focus. */
export function holdingTab(refusal: Refusal): string | null {
  return refusal.type === "orphaned" ? null : refusal.tabId;
}

/** Why the session could not be opened here, in words that name the actual
 *  holder: "already open" is not actionable if you cannot tell where. */
export function refusalMessage(refusal: Refusal): string {
  switch (refusal.type) {
    case "alreadyMineFocus":
      return "This session is already open in another tab. Two drivers on one transcript corrupt it.";
    case "heldByOther":
      return refusal.surface === "ptyAgent"
        ? "This session is already open in a terminal tab. Two drivers on one transcript corrupt it."
        : "This session is already open in a chat. Two drivers on one transcript corrupt it.";
    case "orphaned":
      return "A previous Tori left this session running. It has to end before the session can be reopened.";
  }
}

/** Said when the claim was granted but something outside Tori is resuming the
 *  same id. We cannot prevent that one, only report it. */
export const CONTESTED_NOTICE =
  "This session is also running outside Tori. Two drivers on one transcript will corrupt it.";
