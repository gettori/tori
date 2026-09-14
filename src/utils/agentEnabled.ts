// Which agents this install actually offers.
//
// Two independent facts, and neither one is the other: health says what *could*
// run on this machine, and the stored answer says what the user *wants* offered.
// A picker lists an agent only when both agree, which is why every surface asks
// `agentEnabled` rather than reading either half and drawing its own conclusion.
//
// The default is off. A registry that ships seven agents on a machine where
// nobody has seven installed makes every picker a list of things that do not
// work, so the honest starting set is empty and the user adds to it from
// Settings > Agents.
import { agents, chatCapable, findAdapter, type Adapter } from "./agents";
import {
  agentHealthFor,
  agentReady,
  asProfileId,
  asTabProfile,
  knownProfile,
  noAccounts,
  profileSignedOut,
} from "./agentHealth";
import { saveSettings, settings, settingsLoaded } from "../panels/Settings/settingsStore";
import { allowedRows, soleProfile } from "./projectAgents";

/** The stored answer alone, with no health folded in. */
export function agentChosen(id: string): boolean {
  return settings.agent?.enabled?.[id] === true;
}

/**
 * Why this agent cannot be turned **on**, in the user's terms, or null.
 *
 * Turning one on is a new claim, so it takes a positive health verdict: the
 * sweep has answered for this agent, found the binary, and was not told nobody
 * is signed in. A sweep that has not landed is therefore not a yes - "Ready" is
 * what the Agents table is printing beside the switch, and a switch that moved
 * before the verdict did would be promising what the row has not said yet.
 *
 * `signedOut` is the CLI's own answer and only that. Four of the seven bundled
 * agents declare no `whoami` probe at all and report `unknown` forever; reading
 * that as "not signed in" would make them permanently un-offerable over
 * bookkeeping Sway does not have.
 *
 * Version drift is not in here. A binary older than the one Sway measured
 * against still runs, so it is a notice on the row and never a gate - the same
 * stance `agentReady` takes and the Agents table's "Outdated" pill restates.
 */
export function enableBlockedReason(id: string): string | null {
  const row = agentHealthFor(id);
  if (!row) return "Still being checked";
  if (row.status === "notFound") return "Install it first";
  if (noAccounts(id)) return "Add an account first";
  if (row.signIn === "signedOut") return "Sign in first";
  return null;
}

/**
 * Whether this agent is offered here: chosen by the user, and still usable.
 *
 * `agentReady` rather than `enableBlockedReason`, and the difference is only
 * the pending sweep. An agent already turned on had a verdict when it was, so
 * treating a probe still in flight as "gone" would empty every picker for the
 * second or two the sweep takes - on exactly the machines where it takes
 * longest. Turning one on is the strict question; keeping one on is not.
 */
export function agentEnabled(id: string, profile: string | null = null): boolean {
  return agentChosen(id) && agentReady(id, profile);
}

/** Why this agent is not offered, or null when it is. What a refused action
 *  says, so the reader learns whether to flip a switch or fix an install.
 *
 *  `profile` is the account the caller means; `null` is the default one. Being
 *  signed out is per account, so a draft on Fonn must not be refused because
 *  the personal login expired, and must not be let through because Fonn's did
 *  not. Everything else here is per agent: a binary is installed or it is not,
 *  and the Settings switch is one per agent. */
export function agentOffReason(id: string, profile: string | null = null): string | null {
  // Silent until the file has been read. The built-in defaults enable nothing,
  // so answering from them would refuse every agent on the machine, and a
  // refusal is the one answer that must never be a guess.
  if (!settingsLoaded()) return null;
  if (agentEnabled(id, profile)) return null;
  const label = findAdapter(id).label;
  if (!agentChosen(id)) return `${label} is turned off in Settings`;
  if (noAccounts(id) && agentHealthFor(id)?.status !== "notFound") return `${label} has no account set up`;
  // The same wording whichever account it is. Naming the profile here would put
  // an id the user never chose into a sentence, and the row they pressed
  // already says which account they are on.
  return profileSignedOut(id, profile) ? `${label} is signed out` : `${label} is not installed`;
}

/**
 * Turn this agent on or off.
 *
 * Off **deletes** the key rather than storing `false`: absent and false mean the
 * same thing here, and a file that accumulated a `false` for every agent the
 * user glanced at would be recording where the cursor went, not a preference.
 *
 * Swallowed on failure like every other preference write: the switch has already
 * moved on screen, and the store is what the pickers read.
 */
export function setAgentEnabled(id: string, on: boolean): void {
  const enabled = { ...(settings.agent?.enabled ?? {}) };
  if (on) enabled[id] = true;
  else delete enabled[id];
  void saveSettings({ ...settings, agent: { ...settings.agent, enabled } }).catch(() => {});
}

/** The agents this install offers, in registry order. */
export function enabledAgents(): Adapter[] {
  return agents().filter((a) => agentEnabled(a.id));
}

/** The offered agents a chat can be started with. */
export function enabledChatAgents(): Adapter[] {
  return enabledAgents().filter(chatCapable);
}

/**
 * The agent a new chat draft should open on, or null when there is none.
 *
 * The remembered id where it still qualifies, the first offered agent
 * otherwise. Null rather than a fallback to claude: with nothing enabled there
 * is no honest answer, and starting a draft on an agent the user turned off
 * would make the setting a suggestion.
 *
 * Qualifying includes the rows the project holding `folder` allows. Where it
 * allows none that is offered, the draft still opens, and refuses by name.
 */
export function draftChatAgent(preferred: string | null | undefined, folder?: string | null): string | null {
  const offered = enabledChatAgents();
  const rows = allowedRows(folder);
  const fits = (id: string) => offered.some((a) => a.id === id) && (!rows || rows.some((r) => r.agent === id));
  if (preferred && fits(preferred)) return preferred;
  return offered.find((a) => fits(a.id))?.id ?? offered[0]?.id ?? null;
}

/**
 * The account a new session of this agent starts on, in the tab model's
 * spelling.
 *
 * Three layers, in the order the plan settled on: what this project last used,
 * this agent's Settings default, and the login the user already had (the first
 * listed account where there is none). Each remembered id is checked rather
 * than trusted, the way `draftChatAgent` checks an agent, because an account
 * can be removed while a project still names it.
 *
 * `remembered` arrives in the **stored** spelling, where the default account is
 * the literal `"default"`. A `??` chain would be wrong here: `knownProfile`
 * answers `null` for the default account, and falling through that would let
 * the Settings default overrule a project that had chosen it.
 *
 * The rows the project holding `folder` allows (see `utils/projectAgents`) have
 * the last word: an answer they leave out gives way to this agent's first
 * account they keep.
 */
export function draftChatProfile(
  agentId: string,
  remembered?: string | null,
  folder?: string | null,
): string | null {
  const picked = layeredProfile(agentId, remembered);
  const allowed = allowedRows(folder)?.filter((r) => r.agent === agentId);
  if (!allowed?.length || allowed.some((r) => r.profile === asProfileId(picked))) return picked;
  const kept = allowed.map((r) => knownProfile(agentId, r.profile)).find((p) => p !== undefined);
  // Rows whose accounts are all gone still name one, so the spawn refuses with
  // the project's reason instead of starting on a login it does not allow.
  return kept !== undefined ? kept : asTabProfile(allowed[0].profile);
}

function layeredProfile(agentId: string, remembered?: string | null): string | null {
  const project = knownProfile(agentId, remembered);
  if (project !== undefined) return project;
  const chosen = knownProfile(agentId, settings.agent?.defaultProfiles?.[agentId]);
  if (chosen !== undefined) return chosen;
  return asTabProfile(soleProfile(agentId));
}

/** The account this agent's new sessions start on absent a project's own
 *  memory, in the backend's spelling. */
export function defaultProfile(agentId: string): string {
  return settings.agent?.defaultProfiles?.[agentId] ?? asProfileId(null);
}

/**
 * Set which account this agent's new sessions start on.
 *
 * The default account **deletes** the entry rather than storing `"default"`,
 * the same way turning an agent off deletes its key: absent and `"default"` are
 * one answer, and a stored one would also outlive an install that later has
 * only the one account.
 */
export function setDefaultProfile(agentId: string, profileId: string): void {
  const defaultProfiles = { ...(settings.agent?.defaultProfiles ?? {}) };
  if (asTabProfile(profileId)) defaultProfiles[agentId] = profileId;
  else delete defaultProfiles[agentId];
  void saveSettings({ ...settings, agent: { ...settings.agent, defaultProfiles } }).catch(() => {});
}
