// What a chat session can be switched to, from the two places that can say so.
//
// **One module owns this** because the model picker, the effort control, the
// context meter and the settings restore all have to agree about what a model
// is; four readers reaching into two differently-shaped sources is how they end
// up offering a model one of them cannot resolve.
//
// The two sources are not equal and the difference is measured, not assumed:
//
//   - The **live catalogue** rides the `initialize` control response and is the
//     truth about what this machine's CLI can run right now. It carries `value`
//     (what `--model` takes) and `resolvedModel` (what `system/init` reports
//     back) as separate fields, because several values resolve to one id.
//   - The **adapter table** (`[[chat.models]]`) is hand-maintained TOML. It is
//     the fallback for a session that never handshook, and it is the *only*
//     declared source of context windows - the live catalogue has none.
//
// So a live model's window is looked up in the adapter table by `resolvedModel`,
// and a model with no declared window reports null rather than a guess.
import type { ChatConfig, ChatMode, ChatModel } from "./agents";
import type { ChatModelInfo, Usage } from "./chatTypes";

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
  /** Null when nothing declares a window, which is what keeps the meter from
   *  rendering a denominator it invented. */
  contextWindow: number | null;
  /** False for a model that came from the adapter table because the handshake
   *  did not happen. Surfaced so the picker can say the list may be stale. */
  live: boolean;
  /** Whether this model has a fast mode to toggle. Adapter-declared and looked
   *  up by `resolvedModel`, exactly like `contextWindow`, because the live
   *  catalogue declares no such flag. */
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

/** The window the adapter declares for a resolved model id, or null. The live
 *  catalogue carries no window, so this is the only source of one. */
export function contextWindowFor(chat: ChatConfig | null, resolvedModel: string): number | null {
  return chat?.models.find((m) => m.id === resolvedModel)?.context_window ?? null;
}

/** Whether the adapter declares a fast mode for a resolved model id. Same
 *  lookup as the window, and for the same reason: the live catalogue has no
 *  flag for it, so the adapter is the only source. */
export function fastModeFor(chat: ChatConfig | null, resolvedModel: string): boolean {
  return chat?.models.find((m) => m.id === resolvedModel)?.fast_mode ?? false;
}

function fromAdapter(m: ChatModel): PickableModel {
  // The adapter table names models by their resolved id, so `value` and
  // `resolvedModel` are the same string here. That is not a special case to
  // paper over: `--model claude-sonnet-5` is a valid pick, it is just a less
  // convenient one than the alias the live catalogue offers.
  return {
    value: m.id,
    resolvedModel: m.id,
    label: m.label,
    description: "",
    effortLevels: m.effort_levels,
    contextWindow: m.context_window,
    live: false,
    fastMode: m.fast_mode ?? false,
    // The adapter table declares no capability flags of its own, and a session
    // reading from it never handshook. Claiming a capability here would be a
    // guess about a model this build has only a hand-maintained row for.
    supportsAutoMode: false,
  };
}

/**
 * Everything the picker may offer, live catalogue first and the adapter table
 * only when there is no live one.
 *
 * Not a merge. A session that handshook has the authoritative list, and folding
 * the TOML into it would re-offer a model the CLI no longer has purely because
 * a hand-maintained file still mentions it.
 */
export function pickableModels(live: readonly ChatModelInfo[], chat: ChatConfig | null): PickableModel[] {
  if (live.length > 0) {
    return live.map((m) => ({
      value: m.value,
      resolvedModel: m.resolvedModel,
      label: m.displayName || m.value,
      description: m.description,
      // `supportsEffort` and the level list can disagree only by being absent;
      // the levels are what the control renders, so they are what decides.
      effortLevels: m.supportsEffort ? m.supportedEffortLevels : [],
      contextWindow: contextWindowFor(chat, m.resolvedModel),
      live: true,
      fastMode: fastModeFor(chat, m.resolvedModel),
      supportsAutoMode: m.supportsAutoMode,
    }));
  }
  return (chat?.models ?? []).map(fromAdapter);
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
export function capabilitiesFor(model: PickableModel | null, chat: ChatConfig | null): Capabilities {
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
    modes: (chat?.modes ?? []).filter((m) => !m.requires || capabilities(model).has(m.requires)),
    fastMode: model?.fastMode ?? false,
  };
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
): string | null {
  if (current === null) return null;
  const allowed = capabilitiesFor(model, chat).modes;
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
