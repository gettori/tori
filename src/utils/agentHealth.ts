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

export type AgentHealth = {
  id: string;
  label: string;
  program: string;
  status: BinaryStatus;
  // For the **default** profile: what a session started without choosing an
  // account runs as. Per-profile answers come from `agent_accounts`.
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
/** The agent's own answer that nobody is signed in, and only that: `unknown`
 *  is not a no. Told apart from `agentReady` because the two failures need
 *  different words - a missing binary is installed, a missing login is not. */
export function agentSignedOut(id: string): boolean {
  return agentHealth()?.find((h) => h.id === id)?.signIn === "signedOut";
}

export function agentReady(id: string): boolean {
  const all = agentHealth();
  if (!all) return true;
  const row = all.find((h) => h.id === id);
  // An adapter with no health row is one the sweep did not cover, which is
  // ignorance again rather than a verdict.
  if (!row) return true;
  return row.status !== "notFound" && row.signIn !== "signedOut";
}

/** The binary's version as the sweep measured it, or null while nothing has. */
export function agentVersion(id: string): string | null {
  return agentHealth()?.find((h) => h.id === id)?.version ?? null;
}
