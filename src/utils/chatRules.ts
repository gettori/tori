// The allow rules a chat runs without asking, and the signal that says they
// changed.
//
// The rules themselves live on disk, in the compiled file the hook helper reads
// on every tool call - not here. What lives here is one revision counter, for a
// reason the per-panel version got wrong: a project rule is shared by every chat
// open on that folder, so granting one in the left-hand chat silently changed
// what the right-hand chat would do while its list still said otherwise. A panel
// that only refreshed after *its own* edits was showing a private view of shared
// state.
//
// Deliberately a bare counter rather than a cached rule set. The file is the
// authority; a cache here would be a second one, and the two would disagree the
// first time a rule was written by anything other than a click.
import { createSignal } from "solid-js";
import type { PermissionScope } from "./chatTypes";

/** One entry of `chat_list_rules`. */
/** What a rule does when it matches. `deny` and `ask` are restrictions and beat
 *  `allow`, whatever order the rules happen to sit in. */
export type RuleKind = "allow" | "ask" | "deny";

/** Why a rule exists: reached for, or accepted from an offer Sway made after
 *  counting repeat approvals. */
export type RuleOrigin = "manual" | "learned";

export type ScopedRule = {
  tool: string;
  prefix: string | null;
  glob: string | null;
  kind: RuleKind;
  origin: RuleOrigin;
  scope: PermissionScope;
};

/** Sway's offer to stop asking about a call the user keeps approving by hand. */
export type RuleOffer = {
  tool: string;
  prefix: string;
  approvals: number;
};

const [revision, setRevision] = createSignal(0);

/** Read to re-run when any chat changes a rule. */
export { revision as rulesRevision };

/** A rule was added or removed. Every open chat re-reads its own file: they may
 *  share a project store, and the read is one file, not one per tool call. */
export function noteRulesChanged(): void {
  setRevision(revision() + 1);
}

/** What a rule actually covers, in the same words the approval buttons used. */
export function ruleLabel(rule: ScopedRule): string {
  // The glob is the scope when there is one: a restriction is written *about* a
  // pattern, so showing the tool alone would hide the part that decides where it
  // bites. `kind` leads for a restriction and is left off an allow rule, which
  // is what the list has always been made of and needs no word for.
  const where = rule.glob ?? rule.prefix ?? "anything";
  const what = rule.kind === "allow" ? rule.tool : `${rule.kind} ${rule.tool}`;
  return `${what} · ${where}`;
}

/** The one-line "why is this here" for a rule, or null when it is the ordinary
 *  case of a rule the user wrote. */
export function ruleOriginNote(rule: ScopedRule): string | null {
  return rule.origin === "learned" ? "Added by Sway after you approved this a few times." : null;
}
