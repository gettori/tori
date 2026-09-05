// How deep Sway reads each agent's quota, and how loudly it says so.
//
// Two facts again, the shape `agentEnabled` already has: the **adapter** says
// which rungs of the ladder Sway has a read path for, and the stored answer says
// which of them the user wants climbed. Every surface asks here rather than
// reading either half, because neither half alone gives an answer.
//
// **The absence of an entry is not "off".** An agent nobody has answered for
// resolves to the first rung its `[usage]` table declares, which today is a
// passive reading that costs nothing and needs no opt-in; an agent that declares
// no ladder resolves to `off` because there is nothing to climb. A stored `off`
// is the user's own no, and no later adapter bump undoes it.
import { findAdapter, type UsageRung } from "./agents";
import { asProfileId } from "./agentHealth";
import {
  saveSettings,
  settings,
  type UsageDetail,
  type UsageSettings,
  type UsageSource,
} from "../panels/Settings/settingsStore";

/** The rungs this adapter has a read path for, in the order the ladder climbs.
 *  Empty for an adapter that declares none, which is every bundled agent but
 *  Claude today. */
export function declaredRungs(agentId: string): UsageRung[] {
  return findAdapter(agentId)?.usage?.sources ?? [];
}

/** Why this agent offers no source, in the loader's own words, or null when it
 *  offers one. Shown beside the greyed control rather than left to the pane to
 *  guess: predating the table and declaring nothing are different facts. */
export function usageUnavailableReason(agentId: string): string | null {
  return declaredRungs(agentId).length > 0 ? null : (findAdapter(agentId)?.usage_reason ?? null);
}

/**
 * Which rung Sway climbs for this agent.
 *
 * A stored rung the adapter no longer declares falls back to the first one it
 * does, rather than to `off`. The ladder is cumulative, so the honest reading of
 * "I asked for the deepest source available" is the deepest one still available,
 * and silencing the free passive rung over a downgrade nobody made would lose a
 * reading for no reason.
 */
export function usageSource(agentId: string): UsageSource {
  const rungs = declaredRungs(agentId);
  if (rungs.length === 0) return "off";
  const stored = settings.agent?.usage?.[agentId]?.source;
  if (stored === "off") return "off";
  if (stored && rungs.includes(stored)) return stored;
  return rungs[0];
}

export function usageDetail(agentId: string): UsageDetail {
  return settings.agent?.usage?.[agentId]?.detail ?? "standard";
}

/** Whether a reached or approaching window may reach the OS. Defaults on, and
 *  quiet by construction: the send path suppresses itself while the window is
 *  focused, so this governs only what happens while you are away. */
export function usageNotify(agentId: string): boolean {
  return settings.agent?.usage?.[agentId]?.notify ?? true;
}

/**
 * Whether this account shows in the titlebar strip.
 *
 * The default account always does. It is the strip's one stable anchor, so the
 * hide control is absent on that row and a settings file naming it is ignored
 * here as well as on the backend's read: two places, because the file is
 * hand-editable and this one is what the strip actually asks.
 */
export function accountOnStrip(agentId: string, profile: string | null): boolean {
  const id = asProfileId(profile);
  if (id === asProfileId(null)) return true;
  return !(settings.agent?.usage?.[agentId]?.hiddenProfiles ?? []).includes(id);
}

/** The whole entry as the surfaces read it, resolved rather than stored. */
export function resolvedUsage(agentId: string): UsageSettings {
  return {
    source: usageSource(agentId),
    detail: usageDetail(agentId),
    notify: usageNotify(agentId),
    hiddenProfiles: settings.agent?.usage?.[agentId]?.hiddenProfiles ?? [],
  };
}

/**
 * Write one part of an agent's answer, filling the rest from what is resolved
 * today rather than from the type's defaults.
 *
 * Answering "notify off" on an agent nobody had answered for must not also
 * silently store `source: "off"`, which is what a `{...default, ...patch}` would
 * do. Storing what the user was looking at is the only reading that keeps the
 * control honest.
 */
export function setUsage(agentId: string, patch: Partial<UsageSettings>): Promise<void> {
  const usage = { ...(settings.agent?.usage ?? {}) };
  usage[agentId] = { ...resolvedUsage(agentId), ...patch };
  return saveSettings({ ...settings, agent: { ...settings.agent, usage } });
}

/** Show or hide one account on the strip. The default account is never stored:
 *  it cannot be hidden, so an entry for it could only ever be a lie. */
export function setAccountOnStrip(agentId: string, profile: string | null, shown: boolean): Promise<void> {
  const id = asProfileId(profile);
  if (id === asProfileId(null)) return Promise.resolve();
  const held = settings.agent?.usage?.[agentId]?.hiddenProfiles ?? [];
  const hiddenProfiles = shown ? held.filter((p) => p !== id) : [...new Set([...held, id])];
  return setUsage(agentId, { hiddenProfiles });
}
