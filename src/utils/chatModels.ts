// What a chat session can be switched to, from the two places that can say so.
//
// **One module owns this** because the model picker, the effort control, the
// context meter and the settings restore all have to agree about what a model
// is; four readers reaching into two differently-shaped sources is how they end
// up offering a model one of them cannot resolve.
//
// Both sources are the harness's own answer, and the difference between them is
// only how fresh it is:
//
//   - The **live catalogue** rides the `initialize` control response and is the
//     truth about what this machine's CLI can run right now. It carries `value`
//     (what `--model` takes) and `resolvedModel` (what `system/init` reports
//     back) as separate fields, because several values resolve to one id.
//   - The **cache** is the same answer, from the last time `catalog_probe` asked
//     this harness. It exists so a picker opened before any session does can
//     offer something true rather than nothing.
//   - **Nothing.** A harness that has neither has no models, and says so.
//
// What is *not* a source any more: the adapter's `[[chat.models]]`. That was
// hand-maintained TOML, and it was wrong in both jobs it had. It offered four
// models to a session that never handshook regardless of what the installed CLI
// could run, and its windows said 200k for models the harness reports 1M for.
// Sway names no model the harness did not name first.
//
// A completed turn reports the real context window, per model and per provider,
// in `modelUsage`. It is the authority and it cannot drift, being the running
// session describing itself; it just does not exist until turn one ends, and
// nothing stands in for it before then. See `contextWindowFor`.
import { foreignWindow } from "./modelCaps";
import type { ChatConfig, ChatMode } from "./agents";
import type { CatalogModel } from "./modelCatalog";
import type { ChatModeInfo, ChatModelInfo, Usage } from "./chatTypes";

export type PickableModel = {
  /** What `--model` takes, and the authority for the picker's own selection:
   *  `system/init` reports the resolved id, which several values share, so the
   *  value that was sent is the only record of which one was picked. */
  value: string;
  /** What `system/init.model` reports once the switch lands. */
  resolvedModel: string;
  label: string;
  description: string;
  /** Empty for a model with no effort control, which hides the control rather
   *  than rendering an inert one. Measured: haiku omits the effort keys
   *  entirely rather than declaring them empty. */
  effortLevels: string[];
  /** Null until a completed turn reports one, which is what keeps the meter
   *  from rendering a denominator it invented. */
  contextWindow: number | null;
  /** False for a model that came from the cache because this session has not
   *  handshaken yet. Surfaced so the picker can say the list may be stale. */
  live: boolean;
  /** This row is a model the user configured in the harness's own settings, not
   *  one the harness published. It carries an empty `resolvedModel`, since Sway
   *  passes the configured string to the CLI unresolved. */
  userConfigured: boolean;
  /** Whether this model has a fast mode to toggle. Sway's own annotation,
   *  looked up by `resolvedModel`, because no catalogue carries such a flag. */
  fastMode: boolean;
  /** Whether this model honours `--permission-mode auto`. From the live
   *  catalogue, which omits the key entirely for a model that lacks it. */
  supportsAutoMode: boolean;
};

/**
 * How much of the context window the conversation currently occupies.
 *
 * **The latest turn's figure, not a sum over turns.** A turn's input already
 * contains the whole conversation so far, so adding turns together would count
 * the same history once per turn and cross the window long before the session
 * actually did. It still grows across turns, which is what the meter shows -
 * the growth is in each turn's input, not in an accumulator here.
 *
 * Cache reads and writes count because they are context the model was given;
 * only the output is left out, since it becomes input on the next turn and
 * would otherwise be counted twice. This is the same rule the session-detail
 * parser uses (`sessions.rs`), so the two never disagree about one session.
 *
 * Null before any turn has reported usage, which keeps the meter from showing
 * an empty window as an achievement.
 */
export function contextTokens(usage: Usage | null): number | null {
  if (usage === null) return null;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * The windows the **harness itself reported**, keyed by every id it named them
 * under, from a completed turn's `modelUsage`.
 *
 * Measured: every `result` frame carries
 * `modelUsage[<id>] = { contextWindow, canonicalModel, provider, ... }`. That
 * is the authoritative answer and it needs no rule of ours: it already accounts
 * for the model, the provider and whatever the account is entitled to, and it
 * cannot drift, because it is the running session describing itself.
 *
 * Both the map key and `canonicalModel` are recorded, because they differ: the
 * key can be dated (`claude-haiku-4-5-20251001`) while `canonicalModel` is not
 * (`claude-haiku-4-5`), and either may be what `system/init` reports back.
 *
 * The map holds every model a turn touched, not just the one that was picked -
 * a sonnet turn also bills haiku for its side work - so callers must look up
 * the model they mean rather than taking the only entry.
 */
export function reportedWindows(extra: Record<string, unknown> | undefined): Record<string, number> {
  const usage = extra?.modelUsage;
  if (!usage || typeof usage !== "object") return {};
  const out: Record<string, number> = {};
  for (const [id, raw] of Object.entries(usage as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { contextWindow?: unknown; canonicalModel?: unknown };
    if (typeof entry.contextWindow !== "number" || entry.contextWindow <= 0) continue;
    out[id] = entry.contextWindow;
    if (typeof entry.canonicalModel === "string" && entry.canonicalModel) {
      out[entry.canonicalModel] = entry.contextWindow;
    }
  }
  return out;
}

/**
 * The context window for a resolved model id, from the best source that knows
 * one, or null when none does.
 *
 * The order is the point:
 *
 *   1. **What the session reported** (`reported`). Measured per model and per
 *      provider by the harness that is running the turn, so it beats anything
 *      written down anywhere. It only exists once a turn has completed.
 *   2. **A catalogue lookup, for non-Claude ids only** (`foreignWindow`). A
 *      Claude id never reaches it: step 1 is closer to the truth than a third
 *      party's idea of the same number, and a Claude id arriving here means
 *      nothing knew, which is an answer rather than a cue to guess.
 *   3. **Nothing.** No guess by family, no rounding to a familiar number. A
 *      meter with an invented denominator reads as a measurement.
 *
 * There used to be a step between the two: the adapter's declared window, as
 * the pre-first-turn answer. It is gone with the table it came from, and it is
 * the one step that was demonstrably wrong (Sonnet 5 and Opus 5 both declared
 * 200k against a reported 1M). **So a Claude session shows no denominator at all
 * until its first turn completes.** That is the accepted cost of not printing a
 * number nobody measured.
 *
 * Note what is deliberately *not* a step: the `[1m]` suffix some catalogue
 * values carry (`claude-fable-5[1m]`). It is real but redundant - the session
 * reports the same fact directly - and parsing an id for meaning is how a
 * resolver acquires a vendor's naming convention as a dependency.
 */
export function contextWindowFor(
  resolvedModel: string,
  reported: Readonly<Record<string, number>> = {},
): number | null {
  return reported[resolvedModel] ?? foreignWindow(resolvedModel);
}

/**
 * How much of the window is spoken for, or **null when the answer would be a
 * lie**.
 *
 * Above 100% is not a percentage to clamp, it is a contradiction: the session
 * cannot have used more context than it has, so one of the two numbers is
 * wrong and the window is by far the likelier candidate. A meter that clamped
 * would render a full bar and look like a session on the edge of compaction,
 * which is a specific and alarming claim to make out of a bookkeeping error.
 * Reporting nothing says "we do not know", which is the truth.
 */
export function contextPercent(used: number | null, window: number | null): number | null {
  if (used === null || window === null || window <= 0) return null;
  if (used > window) {
    // Keyed on the window alone, not on the message: `used` grows every turn,
    // so including it would add an entry per turn instead of collapsing a
    // persistent condition to the one line it is.
    warnOnce(
      String(window),
      `context usage ${used} exceeds the resolved window ${window}; the window is wrong, so no percentage is shown`,
    );
    return null;
  }
  return (used / window) * 100;
}

// One line per distinct window. The condition holds for every turn once it
// starts, so logging per render would bury the console in one repeated fact.
const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Whether Sway claims a fast mode for a resolved model id.
 *
 * The one thing still read out of the adapter, and the one thing that has to be:
 * no catalogue carries a fast-mode flag. It is an **annotation**, so it can only
 * decorate a model that reached here from a catalogue in the first place. An
 * annotated id no catalogue named produces no row and therefore no toggle.
 */
export function fastModeFor(chat: ChatConfig | null, resolvedModel: string): boolean {
  return chat?.annotations.find((a) => a.id === resolvedModel)?.fast_mode ?? false;
}

/**
 * Everything the picker may offer: the live catalogue, else the cached one,
 * else nothing at all.
 *
 * **Not a merge, at either step.** A session that handshook has the
 * authoritative list, and folding a cached answer into it would re-offer a model
 * this CLI no longer has purely because an older probe saw it. The same argument
 * that retired the adapter table applies to the cache the moment something
 * fresher exists.
 *
 * Nothing is the third answer and a real one. A harness whose cache is empty and
 * whose session never handshook offers no models, rather than four the CLI was
 * never asked about.
 */
export function pickableModels(
  live: readonly ChatModelInfo[],
  cached: readonly CatalogModel[],
  chat: ChatConfig | null,
  /** Windows the running session reported, from `reportedWindows`. Empty before
   *  the first turn completes, and nothing stands in for it until then. */
  reported: Readonly<Record<string, number>> = {},
): PickableModel[] {
  // `CatalogModel` is a `ChatModelInfo` with one optional extra, so a live row is
  // already one of these. Typing the union this way rather than casting per row
  // is what keeps the two sources genuinely interchangeable here.
  const rows: readonly CatalogModel[] = live.length > 0 ? live : cached;
  return rows.map((m) => ({
    value: m.value,
    resolvedModel: m.resolvedModel,
    label: m.displayName || m.value,
    description: m.description,
    // `supportsEffort` and the level list can disagree only by being absent;
    // the levels are what the control renders, so they are what decides.
    effortLevels: m.supportsEffort ? m.supportedEffortLevels : [],
    contextWindow: contextWindowFor(m.resolvedModel, reported),
    live: live.length > 0,
    userConfigured: m.userConfigured ?? false,
    fastMode: fastModeFor(chat, m.resolvedModel),
    supportsAutoMode: m.supportsAutoMode,
  }));
}

/**
 * The model a picker should show as selected.
 *
 * `picked` is the value last sent, which wins because it is the only thing that
 * knows *which* value was chosen. Without one, the session's resolved id is all
 * there is, and it may match several entries - `default` and `sonnet` both
 * resolve to `claude-sonnet-5`. First match wins there, and it is a display
 * choice rather than a claim: nothing downstream treats it as the picked value.
 */
export function selectedModel(
  models: readonly PickableModel[],
  picked: string | null,
  resolvedModel: string | null,
): PickableModel | null {
  if (picked !== null) {
    const exact = models.find((m) => m.value === picked);
    if (exact) return exact;
  }
  if (resolvedModel !== null) {
    const matches = models.filter((m) => m.resolvedModel === resolvedModel);
    // Several values share one resolution, and they are not equally informative:
    // `default` and `fable-5` both resolve to the same id, but only one of them
    // tells the reader what is running. Taking the first match named the alias,
    // so a fresh session showed "Default" while the toolbar showed "fable-5" for
    // the very same model. Prefer the entry that names the model: an exact
    // value/id match first, then any value that is not the generic alias.
    return (
      matches.find((m) => m.value === resolvedModel) ??
      matches.find((m) => m.value !== "default") ??
      matches[0] ??
      null
    );
  }
  return null;
}

/**
 * The remembered picks a new session can actually be given.
 *
 * A stored preference is not a command: the catalogue may have moved since it
 * was written, and re-sending a model this CLI no longer offers would open every
 * session with an error. So a value the catalogue does not have is dropped and
 * the session keeps the model it started with (the adapter's own default),
 * rather than being switched to something arbitrary or left showing a blank.
 *
 * Effort is dropped the same way when the restored model does not offer it -
 * including when there is no restored model at all, since the level would then
 * be attached to whatever the session happened to start with.
 *
 * **Mode is dropped on the same rule**, and it is the one that has actually
 * moved: modes used to be four hardcoded strings that no catalogue could
 * contradict, so a stored one was always "valid". Now that they come from the
 * adapter, a settings file can name a mode this harness does not declare - a
 * project pinned to `bypassPermissions` opened against a harness whose modes are
 * `auto_edit|yolo`. Dropping it here is what makes the picker show what the
 * session is really running; the backend downgrade (`ChatConfig::resolve_mode`)
 * is the same decision made again where the args are built, for a stored mode
 * that never passes through here at all.
 */
export function restoredPicks(
  models: readonly PickableModel[],
  prefs: { model?: string | null; effort?: string | null; mode?: string | null },
  chat: ChatConfig | null = null,
): { model: PickableModel | null; effort: string | null; mode: string | null } {
  const model = models.find((m) => m.value === prefs.model) ?? null;
  const effort = model && prefs.effort && model.effortLevels.includes(prefs.effort) ? prefs.effort : null;
  const modes = capabilitiesFor(model, chat).modes;
  const mode = prefs.mode && modes.some((m) => m.id === prefs.mode) ? prefs.mode : null;
  return { model, effort, mode };
}

/** What a session may be switched to, once the model has had its say. */
export type Capabilities = {
  /** Empty hides the thinking control rather than rendering an inert one. */
  effortLevels: string[];
  /** The modes on offer, as the adapter declares them. Never a literal list. */
  modes: ChatMode[];
  /** Whether a fast-mode control has any business existing for this model. */
  fastMode: boolean;
};

/**
 * What this model, on this harness, can actually be asked for.
 *
 * **The intersection of two sources, because neither alone is sufficient.** The
 * adapter says what the *harness* supports (Claude has permission modes at all;
 * Codex names its own at runtime). The live catalogue says what *this model*
 * supports, and the two genuinely disagree: every Claude model reports
 * `supportsEffort` and `supportsAdaptiveThinking` except Haiku, which declares
 * none of them. A control offered from the adapter alone would render inert for
 * Haiku; one offered from the model alone could not exist before a handshake.
 *
 * `model` is null before anything is known, which yields the harness's own
 * capabilities minus everything model-scoped - the honest answer for a session
 * whose model has not been reported yet.
 */
export function capabilitiesFor(
  model: PickableModel | null,
  chat: ChatConfig | null,
  /** Modes the running agent published, from `pickableModes`. Empty for a
   *  harness whose modes are declared rather than advertised, which is what
   *  leaves the adapter table in charge. */
  live: readonly ChatMode[] = [],
): Capabilities {
  return {
    effortLevels: model?.effortLevels ?? [],
    // A mode declaring `requires` is offered only to a model that declares that
    // capability. This is the half that has to be a filter rather than a
    // passthrough: measured on claude 2.1.220, `--permission-mode auto` on a
    // model without `supportsAutoMode` exits 0 and silently runs `default`, so
    // an ungated row would let someone pick a mode the session is not in with
    // nothing on the wire to contradict it.
    //
    // A mode requiring a capability is hidden while the model is unknown, since
    // "not known to support it" is the same answer as "does not support it" for
    // anything that would otherwise be silently ignored.
    //
    // The filter still runs over a live list even though no live mode declares
    // `requires` - an agent advertises an id, a label and a description and
    // nothing else. Running it anyway keeps one rule for both sources rather
    // than a branch that would quietly stop gating if agents ever did.
    modes: (live.length > 0 ? live : (chat?.modes ?? [])).filter(
      (m) => !m.requires || capabilities(model).has(m.requires),
    ),
    fastMode: model?.fastMode ?? false,
  };
}

/**
 * The modes a picker may offer, live catalogue first and the adapter table only
 * when there is no live one.
 *
 * The same rule as [`pickableModels`] and not a merge, for the same reason: an
 * agent that published its own modes has the authoritative list, and folding a
 * TOML into it would offer a mode that agent does not have.
 *
 * `args` is empty because an ACP mode is a request rather than a flag, and
 * `permissive` is left undefined rather than false. Undefined means "this
 * harness did not say", which is the truth: Codex's `agent-full-access` really
 * does run tools unattended and nothing on the wire says so, so the row renders
 * without the caution instead of with a claim nobody measured.
 */
export function pickableModes(
  live: readonly ChatModeInfo[],
  chat: ChatConfig | null,
): ChatMode[] {
  if (live.length > 0) {
    return live.map((m) => ({ id: m.id, label: m.label || m.id, hint: m.hint, args: [] }));
  }
  return chat?.modes ?? [];
}

/**
 * The capabilities a model has, keyed by the name the live catalogue uses, so
 * an adapter's `requires` can be written in the harness's own terms.
 *
 * `supportsEffort` is derived from the level list rather than read from a flag
 * of that name, because `pickableModels` has already folded the two together:
 * the flag and the list can disagree only by the list being absent, and the
 * list is what a control would render.
 */
function capabilities(model: PickableModel | null): Set<string> {
  const flags = new Set<string>();
  if (!model) return flags;
  if (model.effortLevels.length > 0) flags.add("supportsEffort");
  if (model.supportsAutoMode) flags.add("supportsAutoMode");
  return flags;
}

/**
 * The mode to move to when switching to `model`, or null to keep the current
 * one.
 *
 * **The gate is only worth anything if the model control cannot walk around
 * it.** A mode can be gated on a capability (`auto` needs `supportsAutoMode`),
 * and hiding its row is enough right up until the user picks it on a model that
 * has the capability and then switches to one that does not. The row disappears
 * and the session is still asking for the mode, which the CLI accepts, exits 0
 * on, and silently runs as something else.
 *
 * This is the same rule the effort level already follows on a model switch. It
 * is a separate function only because mode does not ride the model command and
 * so needs its own request.
 */
export function modeAfterModelSwitch(
  model: PickableModel | null,
  chat: ChatConfig | null,
  current: string | null,
  /** The agent's own modes, when it published some. Without them an ACP
   *  session's `allowed` is the adapter's empty table, and every mode the agent
   *  is actually in reads as no longer offered. That happens to return null
   *  today because the list is empty, which is the right answer reached by
   *  accident and would stop being right the moment the list is non-empty. */
  live: readonly ChatMode[] = [],
): string | null {
  if (current === null) return null;
  const allowed = capabilitiesFor(model, chat, live).modes;
  if (allowed.some((m) => m.id === current)) return null;
  // The default among what is still offered, rather than the adapter's default
  // outright: a gated default would put us straight back in this position.
  return (allowed.find((m) => m.default) ?? allowed[0])?.id ?? null;
}

/**
 * The mode a session runs when nothing is restored: the one the adapter marks,
 * else its first.
 *
 * Positional rather than the literal `"default"` on the miss. Sway used to fall
 * back to that string, which is Claude's spelling of the idea and not a
 * universal one - Gemini's permissive-by-omission mode shares the name by
 * coincidence, and a Codex profile need not contain the word at all.
 */
export function defaultMode(chat: ChatConfig | null): ChatMode | null {
  const modes = chat?.modes ?? [];
  return modes.find((m) => m.default) ?? modes[0] ?? null;
}

/**
 * Whether a reported resolved id confirms that a picked value took effect.
 *
 * This is the only honest test available, and it is deliberately weaker than it
 * looks: `system/init` reports `resolvedModel` and never the value, so when two
 * values share one resolution (`default` and `sonnet`) a switch between them is
 * unconfirmable by construction. Treating the boundary as confirmation there is
 * the least wrong answer, since the request was sent and the CLI applies it at
 * exactly that boundary. What must never happen is the inverse: comparing the
 * picked *value* against init's model, which would report every pick as failed.
 */
export function pickLanded(
  models: readonly PickableModel[],
  picked: string,
  reportedResolvedModel: string,
): boolean {
  const entry = models.find((m) => m.value === picked);
  // An unknown value cannot be confirmed against anything, so the pending
  // marker stays up rather than clearing on a coincidence.
  if (!entry) return false;
  return entry.resolvedModel === reportedResolvedModel;
}
