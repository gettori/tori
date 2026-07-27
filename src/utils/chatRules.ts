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
export type ScopedRule = {
  tool: string;
  prefix: string | null;
  scope: PermissionScope;
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
  return rule.prefix ? `${rule.tool} · ${rule.prefix}` : `${rule.tool} · anything`;
}
