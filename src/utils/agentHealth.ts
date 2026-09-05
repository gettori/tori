// Which agent CLIs this machine actually has, shared by everything that needs
// to know rather than fetched per component.
//
// Mirrors `AgentHealth` in src-tauri/src/health.rs. The backend resolves each
// launch binary against the login-shell PATH and caches the sweep, so asking
// twice is cheap; the store exists so the answer is *the same* in both places,
// not to save the call. A picker that offered a agent the Agents panel was
// simultaneously calling "not installed" would be Sway disagreeing with itself.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type BinaryStatus = "notFound" | "versionUnknown" | "versionMatch" | "versionDrift";

// Installed and signed-in are two independent facts, so this is a second axis
// rather than a fifth `BinaryStatus`. Collapsing them would make "installed,
// version 2.1.231" and "signed out" mutually exclusive when they are routinely
// both true.
export type SignIn = "unknown" | "signedIn" | "signedOut";

/** What the sweep learned about one account of one agent. */
export type ProfileHealth = {
  id: string;
  /** The user's own name for this account. */
  label: string;
  signIn: SignIn;
  account: string | null;
  apiKeySource: string | null;
};

export type AgentHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  // For the **default** profile: what a session started without choosing an
  // account runs as. `profiles` below is the same answer per account.
  signIn: SignIn;
  // The account the agent named, when it names one. Only Claude does, of the
  // three measured.
  account: string | null;
  // The environment variable the agent says it is taking an API key from.
  // Non-null means a subscription login is being overridden by an inherited
  // key, which is a notice and never a block.
  apiKeySource: string | null;
  path: string | null;
  version: string | null;
  verifiedAgainst: string | null;
  // Null for an agent whose sessions only its protocol reaches, which is not a
  // broken install: there is no directory to name.
  sessionsDir: string | null;
  sessionsDirExists: boolean;
  hooks: boolean;
  needsYou: boolean;
  overridePath: string | null;
  // Every account of this agent, default first. One bounded probe each on the
  // sweep, so the send gate can ask about the account a tab is actually on
  // without a subprocess per palette open.
  profiles: ProfileHealth[];
};

// Null means "not asked yet", which is deliberately distinct from an empty
// array: one is ignorance and the other is an answer.
const [agentHealth, setAgentHealth] = createSignal<AgentHealth[] | null>(null);
export { agentHealth };

let requested = false;

/** Fetch the sweep once. Safe to call from every consumer's `onMount`. */
export function ensureAgentHealthLoaded() {
  if (requested) return;
  requested = true;
  invoke<AgentHealth[]>("agent_health")
    .then(setAgentHealth)
    .catch(() => {
      // Leave it null. Unknown health must not read as "nothing is installed",
      // which would empty the picker over a failed IPC call.
      requested = false;
    });
}

/**
 * Re-probe now and publish the result.
 *
 * For anything that could have changed the answer: an install, a completed
 * login. Distinct from `ensureAgentHealthLoaded`, which is a read.
 */
export function refreshAgentHealth(): Promise<AgentHealth[] | null> {
  return invoke<AgentHealth[]>("refresh_agent_health")
    .then((h) => {
      setAgentHealth(h);
      requested = true;
      return h;
    })
    .catch(() => null);
}

/**
 * Is this agent usable enough to start a session with?
 *
 * **Unknown counts as ready.** Before the sweep lands, and if it fails, this
 * says yes. Hiding every agent until a subprocess probe returns would empty
 * the picker on exactly the machines where probing is slowest, and a wrong yes
 * costs one clear spawn failure while a wrong no makes a working agent
 * unreachable with nothing on screen explaining why.
 *
 * Drift is ready on purpose: a version Sway has not measured against usually
 * works, so it is a notice, never a gate. See `keepsDriftAWarning` below.
 *
 * A agent the CLI itself says nobody is signed in to is **not** ready. That is
 * the one place the rule above is stricter, and it earns it: `signedOut` is the
 * agent's own answer rather than Sway's inference, and starting the session
 * anyway produces a tab that asks for a login the chat surface cannot give. Only
 * a definite `signedOut` counts; `unknown` stays ready like everything else.
 */
/**
 * The agent's own answer that nobody is signed in to one **account** of it, and
 * only that: `unknown` is not a no. `null` is the default profile.
 *
 * Told apart from `agentReady` because the two failures need different words: a
 * missing binary is installed, a missing login is signed in to.
 *
 * Per account because the gate is. A draft on the Fonn account blocked because
 * the personal account is signed out is a refusal the user cannot act on from
 * that tab, and one let through because Fonn is signed in is a session that
 * will not start.
 *
 * An account with no row of its own falls back to the agent's default answer,
 * which is what a sweep taken before that account was added holds, and is the
 * direction that stays ready rather than blocking on ignorance.
 */
export function profileSignedOut(id: string, profile: string | null): boolean {
  const row = rows()?.find((h) => h.id === id);
  if (!row) return false;
  const per = profile ? row.profiles?.find((p) => p.id === profile) : null;
  return (per?.signIn ?? row.signIn) === "signedOut";
}

/** The sweep as a list, or null while there is none.
 *
 *  Guarded rather than trusted: `agent_health` is an IPC reply, and one that is
 *  not a list has to read as "nothing answered" rather than throw through every
 *  caller of these three. The Agents table already guards its own copy the same
 *  way, for the same reason. */
function rows(): AgentHealth[] | null {
  const all = agentHealth();
  return Array.isArray(all) ? all : null;
}

/** This agent's row from the sweep, or null while nothing has answered for it.
 *
 *  Null is ignorance, not a verdict, and the two callers that need to tell them
 *  apart read this rather than one of the booleans below - those fold "nobody
 *  asked" into their answer on purpose. */
export function agentHealthFor(id: string): AgentHealth | null {
  return rows()?.find((h) => h.id === id) ?? null;
}

export function agentReady(id: string, profile: string | null = null): boolean {
  const all = rows();
  if (!all) return true;
  const row = all.find((h) => h.id === id);
  // An adapter with no health row is one the sweep did not cover, which is
  // ignorance again rather than a verdict.
  if (!row) return true;
  return row.status !== "notFound" && !profileSignedOut(id, profile);
}

/** The accounts of one agent that are worth naming.
 *
 *  **Empty on a single-account install**: "Default" is a word for the only
 *  thing there is, so a surface that splits per account gets nothing to split
 *  on and renders one plain row. The one place that rule lives - `profileLabel`
 *  is this list looked up by id, and every caller that splits spreads it and
 *  falls back to one unnamed row - rather than each of them counting accounts
 *  and deciding again. */
export function namedProfiles(id: string): readonly ProfileHealth[] {
  const all = rows()?.find((h) => h.id === id)?.profiles ?? [];
  return all.length > 1 ? all : [];
}

/**
 * The user's own name for one account, or null when naming it would say
 * nothing.
 *
 * Null on a single-account install, mirroring the rule the session index
 * already applies (`sessions.rs::profile_label`): "Default" is a word for the
 * only thing there is, and putting it on every chat header would be a label
 * nobody can act on. So a surface renders whatever this returns and does not
 * have to count accounts itself.
 */
export function profileLabel(id: string, profile: string | null): string | null {
  return namedProfiles(id).find((p) => p.id === asProfileId(profile))?.label ?? null;
}

/** The id of the account that is the user's existing login, mirroring
 *  `accounts::DEFAULT_PROFILE_ID`. A tab carries `null` for it, because at the
 *  spawn boundary "unset" is what makes it the default. */
const DEFAULT_PROFILE = "default";

/**
 * One account id in the tab model's spelling: `null` for the default account.
 *
 * The backend has two vocabularies for the same account and both are right
 * where they are. A session row is tagged with the id of the **root** that held
 * its transcript, which is a real profile id and so is the literal `"default"`;
 * a tab spells the same account `null`, because at the spawn boundary the home
 * variable being *unset* is what makes it the default.
 *
 * This is the one crossing. Without it a restored default-account tab would
 * carry `"default"` while a fresh one carried `null`, and every later
 * comparison (a palette row, a remembered pick) would have to know that one
 * account has two names - the shape of [[concept_one_directory_two_spellings]].
 */
export function asTabProfile(id: string | null | undefined): string | null {
  return id && id !== DEFAULT_PROFILE ? id : null;
}

/** The same crossing the other way: one account id in the backend's spelling,
 *  where the default account is the literal `"default"` rather than `null`.
 *
 *  What anything keyed on the account uses - a catalogue row, a probe in
 *  flight - so a key has one shape and `undefined` cannot mean the default
 *  account in one map and nothing at all in the next. */
export function asProfileId(id: string | null | undefined): string {
  return id ?? DEFAULT_PROFILE;
}

/** The binary's version as the sweep measured it, or null while nothing has. */
export function agentVersion(id: string): string | null {
  return rows()?.find((h) => h.id === id)?.version ?? null;
}
