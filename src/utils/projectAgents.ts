// Rules match by path prefix, not through the discovered spaces: those arrive
// after launch, and a rule must not lose that race. Every worktree Tori makes
// inside a repo sits under the repo's path, so it shares the repo's rule.
import { findAdapter } from "./agents";
import { agentHealthFor, asProfileId, namedProfiles, profileLabel } from "./agentHealth";
import { isUnderPath } from "./pathScope";
import { saveSettings, settings, type AgentRow } from "../panels/Settings/settingsStore";

/** What a refused row says, where a sentence will not fit. */
export const NOT_ALLOWED = "Not allowed in this project";

/** The rows one project allows, empty when it has no rule. */
export function projectRows(projectPath: string): AgentRow[] {
  return settings.projectAgents?.[projectPath] ?? [];
}

/** The rows the project holding `folder` allows, or null when it has no rule.
 *  The deepest project wins, for a repo nested inside another. */
export function allowedRows(folder: string | null | undefined): AgentRow[] | null {
  if (!folder) return null;
  let best: { path: string; rows: AgentRow[] } | null = null;
  for (const [path, rows] of Object.entries(settings.projectAgents ?? {})) {
    if (rows.length && isUnderPath(folder, path) && (!best || path.length > best.path.length)) best = { path, rows };
  }
  return best?.rows ?? null;
}

/** The account an agent with nothing to tell apart runs on, in the stored
 *  spelling: its default login where there is one, else its only account. */
export function soleProfile(agentId: string): string {
  const listed = agentHealthFor(agentId)?.profiles;
  return !listed?.length || listed.some((p) => p.id === asProfileId(null)) ? asProfileId(null) : listed[0].id;
}

/** A row's name, spelled the way the palette spells it. */
export function rowLabel(agentId: string, profile: string): string {
  const account = profileLabel(agentId, profile);
  return account ? `${findAdapter(agentId).label} / ${account}` : findAdapter(agentId).label;
}

/** Why the project holding `folder` refuses `agentId` on `profile`, in the tab
 *  spelling, or null when it allows it or has no rule. */
export function agentRefusal(
  folder: string | null | undefined,
  agentId: string,
  profile: string | null,
): string | null {
  const rows = allowedRows(folder);
  if (!rows) return null;
  // A palette row on a one-account install carries `null` whichever account
  // that is, so it is read as the account it would actually run on.
  const id = profile === null && !namedProfiles(agentId).length ? soleProfile(agentId) : asProfileId(profile);
  if (rows.some((r) => r.agent === agentId && r.profile === id)) return null;
  return `${rowLabel(agentId, id)} is not allowed in this project`;
}

/** Replace the rows one project allows. None removes the rule. */
export function setProjectRows(projectPath: string, rows: AgentRow[]): Promise<void> {
  const next = { ...(settings.projectAgents ?? {}) };
  if (rows.length) next[projectPath] = rows;
  else delete next[projectPath];
  return saveSettings({ ...settings, projectAgents: next });
}
