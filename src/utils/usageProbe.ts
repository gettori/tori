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
import { liveChats } from "./chatSessions";
import type { QuotaReading } from "./chatRateLimit";
import { usageSource } from "./usageSettings";
import { accountKey, recordReadings, type AccountKey } from "./usageStore";
import { backoffUntil, mayPoll, type PollClock, type Trigger } from "./usagePoll";

export type ProbeCredits = { hasCredits: boolean; unlimited: boolean; balance: string | null };

/** Who the account is, as the probe's own exchange reported it. */
export type ProbeIdentity = {
  email: string | null;
  planType: string | null;
  credits: ProbeCredits | null;
};

type ProbeAnswer = ProbeIdentity & { windows: QuotaReading[]; reachedType: string | null };

/** Which command reads which agent. A map rather than a switch because it is
 *  also the list of agents the poll runs for at all: an agent absent here has no
 *  read path, whatever its adapter declares. */
const PROBE_COMMAND: Record<string, string> = { codex: "usage_probe_codex" };

/** How often the tick wakes up. Well under the poll interval itself, which
 *  would otherwise drift a whole period past a chat opening. */
const TICK_MS = 60_000;

const [identities, setIdentities] = createSignal<Record<AccountKey, ProbeIdentity>>({});

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

async function runProbe(agentId: string) {
  const clock = clockFor(agentId);
  // Stamped before the await, not after. The floor is about how often Sway
  // spawns a server, and a focus and a hover landing before the first answer
  // would otherwise both pass the schedule and start one each.
  clock.lastPollAt = Date.now();
  try {
    const answer = await invoke<ProbeAnswer>(PROBE_COMMAND[agentId]);
    setIdentities((prev) => ({
      ...prev,
      [accountKey(agentId, null)]: {
        email: answer.email ?? null,
        planType: answer.planType ?? null,
        credits: answer.credits ?? null,
      },
    }));
    recordReadings(agentId, null, "cli", answer.windows ?? []);
    failures[agentId] = 0;
    clock.blockedUntil = null;
  } catch {
    // The reason is not kept: a failed read leaves whatever the last good one
    // said, and a stale reading showing its age beats a fresh error replacing it.
    failures[agentId] = (failures[agentId] ?? 0) + 1;
    clock.blockedUntil = backoffUntil(failures[agentId], Date.now());
  }
}

/** Ask this agent for its quota, if the schedule allows it. */
export function pollUsage(agentId: string, trigger: Trigger) {
  if (!(agentId in PROBE_COMMAND)) return;
  if (!agentEnabled(agentId)) return;
  if (usageSource(agentId) !== "cli") return;
  const ctx = { visible: visibleNow(), chatOpen: chatOpenFor(agentId) };
  if (!mayPoll(clockFor(agentId), trigger, Date.now(), ctx)) return;
  void runProbe(agentId);
}

let watching = false;

/** Start the two triggers that are not a user action. The third, hover, is the
 *  strip's, since only it knows when a pointer is on a row. */
export function watchUsageProbe() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const all = (trigger: Trigger) => {
    for (const agentId of Object.keys(PROBE_COMMAND)) pollUsage(agentId, trigger);
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
  for (const key of Object.keys(clocks)) delete clocks[key];
  for (const key of Object.keys(failures)) delete failures[key];
}
