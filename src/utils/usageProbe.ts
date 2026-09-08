// The half of the `cli` rung that owns a timer and an invoke.
//
// `usagePoll.ts` decides whether a read may run; this runs it, folds the answer
// into the same store the passive rung writes to, and keeps the one thing that
// arrives only here: who the account is. Codex's `login status` names nobody
// (`whoami_kind = "exit_code"`), so `account/read` is the only place an email or
// a plan for it exists, and it rides on the same exchange as the windows.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { agentEnabled } from "./agentEnabled";
import { ensureAdaptersLoaded } from "./agents";
import { asTabProfile, namedProfiles } from "./agentHealth";
import { liveChats } from "./chatSessions";
import type { QuotaReading } from "./chatRateLimit";
import { usageRungFor } from "./usageSettings";
import type { UsageSource } from "../panels/Settings/settingsStore";
import {
  accountKey,
  recordReadings,
  type AccountKey,
  type UsageSource as StoreSource,
} from "./usageStore";
import { backoffUntil, mayPoll, type PollClock, type Trigger } from "./usagePoll";

export type ProbeCredits = { hasCredits: boolean; unlimited: boolean; balance: string | null };

/** Who the account is, as the probe's own exchange reported it. */
export type ProbeIdentity = {
  email: string | null;
  planType: string | null;
  credits: ProbeCredits | null;
};

type ProbeAnswer = ProbeIdentity & { windows: QuotaReading[]; reachedType: string | null };

/** Which command reads which agent, on which rung. A map rather than a switch
 *  because it is also the list of what the poll runs at all: a pair absent here
 *  has no read path, whatever the adapter declares. Keyed by rung as well as by
 *  agent because the two are different reads, and Claude answers on one of them
 *  only after an explicit opt-in. */
const PROBE_COMMAND: Record<string, Partial<Record<UsageSource, string>>> = {
  codex: { cli: "usage_probe_codex" },
  claude: { token: "usage_token_claude" },
};

/** The command for this account's resolved rung, or null when it has none. The
 *  rung travels with it because it is what the reading gets filed under.
 *
 *  Per account, not per agent: two logins of one agent can want different
 *  depths, and the deeper of the two must not drag the other into a Keychain
 *  prompt it never asked for. */
function readPath(agentId: string, profile: string | null): { command: string; rung: StoreSource } | null {
  const rung = usageRungFor(agentId, profile);
  const command = PROBE_COMMAND[agentId]?.[rung];
  return command === undefined || rung === "off" ? null : { command, rung };
}

/** Whether anything can go and ask for this account's quota now, as against
 *  waiting for a chat turn to report it. What a refresh control keys on: a
 *  button that spawns nothing is a button that lies. */
export function canPollUsage(agentId: string, profile: string | null = null): boolean {
  return readPath(agentId, profile) !== null;
}

/** How often the tick wakes up. Well under the poll interval itself, which
 *  would otherwise drift a whole period past a chat opening. */
const TICK_MS = 60_000;

const [identities, setIdentities] = createSignal<Record<AccountKey, ProbeIdentity>>({});

/** Why the last read failed, per account, or null when it did not. Kept because
 *  a rung that cannot answer has to say so: an expired token and a signed-out
 *  account look identical as an absence. Per account because the answer is: one
 *  login can be signed out while the other reads fine. */
const [reasons, setReasons] = createSignal<Record<AccountKey, string | null>>({});

export function usageReason(agentId: string, profile: string | null = null): string | null {
  return reasons()[accountKey(agentId, profile)] ?? null;
}

/**
 * Per account, and this is load bearing.
 *
 * It was per agent, on the reasoning that what the floor protects is the process
 * being spawned. That starved every account but the first: the sweep reads the
 * default login, stamps the shared clock, and the second login is refused for
 * the rest of the interval. The next sweep starts at the default again, so the
 * second account was never read at all and never reached the strip.
 */
const clocks: Record<AccountKey, PollClock> = {};
const failures: Record<AccountKey, number> = {};

/** One read at a time per agent. The floor moved to the account; the thing it
 *  used to protect is still per agent (a spawned process, and on Claude a
 *  Keychain prompt), so two accounts queue behind each other rather than raising
 *  two prompts in the same breath. */
const queues: Record<string, Promise<void>> = {};

/** Which accounts have a read queued or running. A second ask for one of them
 *  is dropped rather than queued: `manual` skips the rate floor on purpose, and
 *  without this a refresh button pressed three times was three reads of the
 *  same endpoint back to back, which is how it answered 429. */
const [pending, setPending] = createSignal<Record<AccountKey, boolean>>({});

export function usageReading(agentId: string, profile: string | null = null): boolean {
  return pending()[accountKey(agentId, profile)] === true;
}

export function usageIdentity(agentId: string, profile: string | null): ProbeIdentity | null {
  return identities()[accountKey(agentId, profile)] ?? null;
}

const visibleNow = () => (typeof document === "undefined" ? true : !document.hidden);

const chatOpenFor = (agentId: string) => liveChats().some((c) => c.agentId === agentId);

function clockFor(key: AccountKey): PollClock {
  return (clocks[key] ??= { lastPollAt: null, blockedUntil: null });
}

async function runProbe(
  key: AccountKey,
  agentId: string,
  profile: string | null,
  command: string,
  rung: StoreSource,
) {
  const clock = clockFor(key);
  try {
    const answer = await invoke<ProbeAnswer>(command, { profile });
    // Only when the answer carries one. Claude's token read returns windows and
    // nothing else, and writing an all-null record for it would replace what the
    // health sweep already knows with a row saying nobody is signed in.
    if (answer.email || answer.planType || answer.credits) {
      setIdentities((prev) => ({
        ...prev,
        [accountKey(agentId, profile)]: {
          email: answer.email ?? null,
          planType: answer.planType ?? null,
          credits: answer.credits ?? null,
        },
      }));
    }
    recordReadings(agentId, profile, rung, answer.windows ?? []);
    failures[key] = 0;
    clock.blockedUntil = null;
    setReasons((prev) => ({ ...prev, [key]: null }));
  } catch (e) {
    // The readings are left alone: a stale number showing its age beats an error
    // replacing it. What the failure buys is a sentence, which the card shows
    // beside whatever a cheaper rung already filled in.
    failures[key] = (failures[key] ?? 0) + 1;
    clock.blockedUntil = backoffUntil(failures[key], Date.now());
    setReasons((prev) => ({ ...prev, [key]: String(e) }));
  } finally {
    setPending((prev) => ({ ...prev, [key]: false }));
  }
}

/**
 * Ask this agent for one account's quota, if the schedule allows it.
 *
 * The read joins the agent's queue rather than starting straight away, so two
 * logins are read one after the other. The floor is stamped here, at the ask,
 * rather than where the process starts: a read can wait behind another
 * account's, and a second trigger landing in that gap would otherwise pass the
 * schedule and queue the same read twice.
 */
export function pollUsage(agentId: string, trigger: Trigger, profile: string | null = null) {
  const path = readPath(agentId, profile);
  if (path === null) return;
  if (!agentEnabled(agentId, profile)) return;
  const key = accountKey(agentId, profile);
  const clock = clockFor(key);
  // Only the `cli` rung spawns anything (`codex app-server`); the token rung is
  // one request, and is scheduled as one.
  const ctx = { visible: visibleNow(), chatOpen: chatOpenFor(agentId), spawns: path.rung === "cli" };
  if (!mayPoll(clock, trigger, Date.now(), ctx)) return;
  if (pending()[key]) return;
  clock.lastPollAt = Date.now();
  setPending((prev) => ({ ...prev, [key]: true }));
  queues[agentId] = (queues[agentId] ?? Promise.resolve()).then(() =>
    runProbe(key, agentId, profile, path.command, path.rung),
  );
}

let watching = false;

/** Start the two triggers that are not a user action. The third, hover, is the
 *  strip's, since only it knows when a pointer is on a row. */
export function watchUsageProbe() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const all = (trigger: Trigger) => {
    for (const agentId of Object.keys(PROBE_COMMAND)) {
      // Every account, not only the default one: a second Claude login has its
      // own Keychain item and its own windows, and the strip has a row for it.
      const accounts = namedProfiles(agentId);
      if (accounts.length === 0) pollUsage(agentId, trigger);
      for (const account of accounts) pollUsage(agentId, trigger, asTabProfile(account.id));
    }
  };
  window.addEventListener("focus", () => all("focus"));
  setInterval(() => all("interval"), TICK_MS);
  // The opening sweep waits for the real adapters. `FALLBACK_ADAPTERS` declares
  // no `[usage]`, so before they land every agent resolves to `off` and the
  // sweep would quietly do nothing until the user refocused the window.
  void ensureAdaptersLoaded().then(() => all("focus"));
}

/** Put one account's identity on record without a probe. Test and story
 *  support, following `seedUsageStoreForTests`. */
export function seedUsageIdentityForTests(
  agentId: string,
  profile: string | null,
  identity: Partial<ProbeIdentity>,
) {
  setIdentities((prev) => ({
    ...prev,
    [accountKey(agentId, profile)]: {
      email: null,
      planType: null,
      credits: null,
      ...identity,
    },
  }));
}

export function resetUsageProbeForTests() {
  setIdentities({});
  setReasons({});
  setPending({});
  for (const key of Object.keys(clocks)) delete clocks[key];
  for (const key of Object.keys(failures)) delete failures[key];
  for (const key of Object.keys(queues)) delete queues[key];
}
