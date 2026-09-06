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
import { usageSource } from "./usageSettings";
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

/** The command for this agent's resolved rung, or null when it has none. The
 *  rung travels with it because it is what the reading gets filed under. */
function readPath(agentId: string): { command: string; rung: StoreSource } | null {
  const rung = usageSource(agentId);
  const command = PROBE_COMMAND[agentId]?.[rung];
  return command === undefined || rung === "off" ? null : { command, rung };
}

/** How often the tick wakes up. Well under the poll interval itself, which
 *  would otherwise drift a whole period past a chat opening. */
const TICK_MS = 60_000;

const [identities, setIdentities] = createSignal<Record<AccountKey, ProbeIdentity>>({});

/** Why the last read failed, per agent, or null when it did not. Kept because a
 *  rung that cannot answer has to say so: an expired token and a signed-out
 *  account look identical as an absence. */
const [reasons, setReasons] = createSignal<Record<string, string | null>>({});

export function usageReason(agentId: string): string | null {
  return reasons()[agentId] ?? null;
}

/** Per agent, because the clock belongs to the process being spawned and Codex
 *  holds one account. */
const clocks: Record<string, PollClock> = {};
const failures: Record<string, number> = {};

export function usageIdentity(agentId: string, profile: string | null): ProbeIdentity | null {
  return identities()[accountKey(agentId, profile)] ?? null;
}

const visibleNow = () => (typeof document === "undefined" ? true : !document.hidden);

const chatOpenFor = (agentId: string) => liveChats().some((c) => c.agentId === agentId);

function clockFor(agentId: string): PollClock {
  return (clocks[agentId] ??= { lastPollAt: null, blockedUntil: null });
}

async function runProbe(agentId: string, profile: string | null, command: string, rung: StoreSource) {
  const clock = clockFor(agentId);
  // Stamped before the await, not after. The floor is about how often Sway
  // spawns a server, and a focus and a hover landing before the first answer
  // would otherwise both pass the schedule and start one each.
  clock.lastPollAt = Date.now();
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
    failures[agentId] = 0;
    clock.blockedUntil = null;
    setReasons((prev) => ({ ...prev, [agentId]: null }));
  } catch (e) {
    // The readings are left alone: a stale number showing its age beats an error
    // replacing it. What the failure buys is a sentence, which the card shows
    // beside whatever a cheaper rung already filled in.
    failures[agentId] = (failures[agentId] ?? 0) + 1;
    clock.blockedUntil = backoffUntil(failures[agentId], Date.now());
    setReasons((prev) => ({ ...prev, [agentId]: String(e) }));
  }
}

/**
 * Ask this agent for one account's quota, if the schedule allows it.
 *
 * The clock is per agent rather than per account, because what the floor is
 * protecting is the process being spawned. Two accounts on one agent share it,
 * which on Claude means the second one waits for the next trigger rather than
 * raising a second Keychain prompt in the same breath.
 */
export function pollUsage(agentId: string, trigger: Trigger, profile: string | null = null) {
  const path = readPath(agentId);
  if (path === null) return;
  if (!agentEnabled(agentId, profile)) return;
  const ctx = { visible: visibleNow(), chatOpen: chatOpenFor(agentId) };
  if (!mayPoll(clockFor(agentId), trigger, Date.now(), ctx)) return;
  void runProbe(agentId, profile, path.command, path.rung);
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
  for (const key of Object.keys(clocks)) delete clocks[key];
  for (const key of Object.keys(failures)) delete failures[key];
}
