// Which quota windows each account puts in the titlebar, how full is too full
// for it, and whether it may say so out loud.
//
// **Per account, not per agent.** A quota window belongs to a login: two Claude
// accounts on one machine have two five-hour windows, on two plans, and a
// per-agent answer could only ever describe one of them.
//
// **The chips say what is drawn, the account's switch says what is read.**
// Nothing lit means nothing is read. With the switch off, the two generic
// windows come off the rung the adapter offers for free, which for Claude means
// a chat has to run. With it on, Tori reads the account's login token and gets
// every window, a chat or not, including the three only that read can answer.
// The switch used to be implied by lighting one of those chips, and an account
// that never touched the switch still answers that way.
//
// **The absence of an answer is not "off".** An account nobody has answered for
// shows the two generic windows, because that reading costs nothing and needs no
// permission. An empty list is the user's own no, and no later adapter bump
// undoes it.
import { findAdapter, type UsageRung } from "./agents";
import { asProfileId } from "./agentHealth";
import { MODEL_FAMILIES, scopedModel, weekQualifier } from "./chatRateLimit";
import { catalogFor } from "./modelCatalog";
import { windowsFor } from "./usageStore";
import { saveSettings, settings, type AccountUsage, type UsageSource } from "../panels/Settings/settingsStore";

/**
 * The three chips, and the one that is not a window kind.
 *
 * `model_week` stands for whichever weekly window this account's plan scopes to
 * a model. It cannot be stored as the kind itself (`seven_day_fable`), because
 * the name arrives only with the first successful read, and the setting has to
 * exist before that read to authorise it.
 */
export type WindowChip = "five_hour" | "seven_day" | "model_week" | "week_other" | "extra_usage";

/** What an account shows when nobody has said otherwise: the two windows every
 *  source reports for free. */
export const GENERIC_CHIPS: WindowChip[] = ["five_hour", "seven_day"];

const CHIPS: WindowChip[] = [...GENERIC_CHIPS, "model_week", "week_other", "extra_usage"];

/**
 * Which chip governs a window kind.
 *
 * Everything a deep read adds beyond the two generic windows arrives on the same
 * rung, but not under the same switch: a week scoped to a model is a thing you
 * pick and run, and a week scoped to overage is not. Folded together, lighting
 * Fable put an overage bar in the titlebar nobody asked for, and on a plan with
 * no model week the model chip was named after extra usage instead.
 */
export function chipFor(kind: string): WindowChip {
  if (kind === "five_hour" || kind === "seven_day" || kind === "extra_usage") return kind;
  return weekQualifier(kind) === null ? "model_week" : "week_other";
}

/** The rungs this adapter has a read path for, in the order the ladder climbs.
 *  Empty for an adapter that declares none, which is every bundled agent but
 *  Claude and Codex today. */
export function declaredRungs(agentId: string): UsageRung[] {
  return findAdapter(agentId)?.usage?.sources ?? [];
}

/** Why this agent reads no quota, in the loader's own words, or null when it
 *  reads some. Shown where the chips would be rather than left to the pane to
 *  guess: predating the table and declaring nothing are different facts. */
export function usageUnavailableReason(agentId: string): string | null {
  return declaredRungs(agentId).length > 0 ? null : (findAdapter(agentId)?.usage_reason ?? null);
}

/** Whether this agent has a model-scoped weekly window to offer at all. Only the
 *  account-token rung answers one, so an agent without that rung shows two chips
 *  rather than a third that could never light. */
export function offersModelWindow(agentId: string): boolean {
  return declaredRungs(agentId).includes("token");
}

const entry = (agentId: string, profile: string | null): AccountUsage | undefined =>
  settings.agent?.usage?.[agentId]?.accounts?.[asProfileId(profile)];

const isChip = (v: string): v is WindowChip => (CHIPS as string[]).includes(v);

/**
 * Which windows this account puts on the strip.
 *
 * A stored list is taken as it is, including the empty one: that is the user
 * turning this account off. No list at all means nobody has answered, which
 * resolves to the free pair rather than to silence.
 */
export function accountWindows(agentId: string, profile: string | null): WindowChip[] {
  if (declaredRungs(agentId).length === 0) return [];
  const stored = entry(agentId, profile)?.windows;
  if (!stored) return [...GENERIC_CHIPS];
  return stored.filter(isChip);
}

export function showsWindow(agentId: string, profile: string | null, chip: WindowChip): boolean {
  return accountWindows(agentId, profile).includes(chip);
}

/** Whether this account has ever answered on the token rung. Evidence that the
 *  Keychain item was opened, not that the number is current: a reading kept from
 *  before a restart still proves the permission was given. */
export function tokenAlreadyRead(agentId: string, profile: string | null): boolean {
  return windowsFor(agentId, profile).some((w) => w.source === "token");
}

/** The chips only the account token can answer. */
export function needsToken(chip: WindowChip): boolean {
  return chip === "model_week" || chip === "week_other" || chip === "extra_usage";
}

/** Whether Tori may read this account's login token. Mirrors `reads_token` in
 *  src-tauri/src/settings.rs, which is the gate; this only decides what to ask. */
export function readsToken(agentId: string, profile: string | null): boolean {
  const own = entry(agentId, profile)?.readToken;
  if (own !== undefined) return own;
  return (entry(agentId, profile)?.windows ?? []).some((c) => c === "model_week" || c === "week_other");
}

/**
 * Which rung reads this account, derived rather than stored.
 *
 * The token rung only behind the account's own switch, even on an adapter that
 * declares it first: it is the one read that opens the login Keychain.
 */
export function usageRungFor(agentId: string, profile: string | null): UsageSource {
  const rungs = declaredRungs(agentId);
  if (rungs.length === 0 || accountWindows(agentId, profile).length === 0) return "off";
  if (rungs.includes("token") && readsToken(agentId, profile)) return "token";
  return rungs.find((r) => r !== "token") ?? "off";
}

/**
 * How full is too full for this account.
 *
 * Falls back to the one shared threshold (Chat > Warn at) until this account's
 * own stepper moves, so an install nobody has fiddled with warns about its
 * agents at the same point it warns about its own spending.
 */
export function usageWarnAt(agentId: string, profile: string | null): number {
  const own = entry(agentId, profile)?.warnAt;
  return typeof own === "number" ? own : (settings.budgets?.warnAtFraction ?? 1);
}

// Off hides every cost figure, and asks the daemon for none of them.
export const showSpend = () => settings.budgets?.showSpend !== false;

/** Whether a reached or approaching window may reach the OS. Defaults on, and
 *  quiet by construction: the send path suppresses itself while the window is
 *  focused, so this governs only what happens while you are away. */
export function usageNotify(agentId: string, profile: string | null): boolean {
  return entry(agentId, profile)?.notify ?? true;
}

/**
 * Write one part of one account's answer.
 *
 * Only the named part: answering "notify off" on an account nobody had answered
 * for must not also store the window list it happened to be showing, or a later
 * change to what the free rung reports would be frozen out by a decision the
 * user never made.
 */
function patchAccount(agentId: string, profile: string | null, patch: Partial<AccountUsage>): Promise<void> {
  const id = asProfileId(profile);
  const usage = { ...settings.agent?.usage };
  const forAgent = usage[agentId] ?? {};
  const accounts = { ...forAgent.accounts };
  accounts[id] = { ...accounts[id], ...patch };
  usage[agentId] = { ...forAgent, accounts };
  return saveSettings({ ...settings, agent: { ...settings.agent, usage } });
}

/** Light or unlight one chip. The list written is the resolved one, so the first
 *  press stores what the user was looking at plus their change, rather than a
 *  default's idea of what was on screen. */
export function setWindowShown(
  agentId: string,
  profile: string | null,
  chip: WindowChip,
  shown: boolean,
): Promise<void> {
  const held = accountWindows(agentId, profile);
  const windows = shown ? CHIPS.filter((c) => c === chip || held.includes(c)) : held.filter((c) => c !== chip);
  // An account still answering through its chips has its switch written down
  // first, so putting out the chip that implied it does not turn the read off.
  const readToken = entry(agentId, profile)?.readToken ?? readsToken(agentId, profile);
  return patchAccount(agentId, profile, { windows, readToken });
}

export function setReadToken(agentId: string, profile: string | null, on: boolean): Promise<void> {
  return patchAccount(agentId, profile, { readToken: on });
}

/** Move this account's threshold, or hand it back to the shared one with null. */
export function setUsageWarnAt(agentId: string, profile: string | null, fraction: number | null): Promise<void> {
  return patchAccount(agentId, profile, { warnAt: fraction });
}

export function setUsageNotify(agentId: string, profile: string | null, notify: boolean): Promise<void> {
  return patchAccount(agentId, profile, { notify });
}

/** Families in the order Anthropic's weekly window climbs them. A plan's scoped
 *  window is for its top model, so the last one this account can run is the
 *  guess. The same list that decides whether a `seven_day_*` window is scoped to
 *  a model at all, so the two answers cannot drift apart. */
const FAMILIES = MODEL_FAMILIES;

/**
 * What to call the model chip, or null when nothing knows yet.
 *
 * A real reading names the model itself, and that answer always wins. Before the
 * first read there is none, so the account's own model list is asked instead:
 * the plan's top model is the one its weekly window is scoped to. Null rather
 * than a placeholder, so a caller can pick its own words for "we do not know
 * which model this account's week is scoped to".
 */
export function modelWindowLabel(agentId: string, profile: string | null): string | null {
  const read = windowsFor(agentId, profile)
    .map((w) => scopedModel(w.kind))
    .find((m): m is string => m !== null);
  if (read) return read;
  const models = catalogFor(agentId, profile)?.catalogue?.models ?? [];
  let best = -1;
  for (const m of models) {
    const hay = `${m.value} ${m.resolvedModel} ${m.displayName}`.toLowerCase();
    FAMILIES.forEach((family, rank) => {
      if (rank > best && hay.includes(family)) best = rank;
    });
  }
  if (best === -1) return null;
  return FAMILIES[best][0].toUpperCase() + FAMILIES[best].slice(1);
}
