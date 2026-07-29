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
import type { ChatConfig, ChatModel } from "./agents";
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
 */
export function restoredPicks(
  models: readonly PickableModel[],
  prefs: { model?: string | null; effort?: string | null },
): { model: PickableModel | null; effort: string | null } {
  const model = models.find((m) => m.value === prefs.model) ?? null;
  const effort = model && prefs.effort && model.effortLevels.includes(prefs.effort) ? prefs.effort : null;
  return { model, effort };
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
