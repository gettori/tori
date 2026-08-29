// The last window a model was *measured* at, kept across sessions.
//
// A Claude session reports its own context window, per model, and only once its
// first turn has completed. That is the best number there is and it is also the
// reason a fresh chat used to show no denominator at all: nothing knew the
// window yet, and the alternatives were all guesses. The adapter's declared
// figure was tried and was wrong (200k for models the agent reports 1M for),
// and a catalogue's idea of the same number is a third party's.
//
// So this remembers the agent's own answer instead of substituting for it. It
// is written only from a completed turn's `modelUsage`, read only when the
// running session has not reported one yet, and overwritten the moment it does.
// The worst case is a denominator that was true on this machine, for this
// model, on the last turn it ran, and that is corrected within one turn.
//
// localStorage rather than a Tauri store: it is a per-machine display detail
// with no business surviving a reinstall, and it is read from a render path
// where an IPC round trip would mean a frame with no window and then a frame
// with one.
const KEY = "sway.contextWindows.v1";

/** Windows by model id, or an empty map when nothing has been measured yet. */
export function rememberedWindows(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && value > 0) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record what a session reported. Merged, never replaced: a turn names only
 *  the models it touched, and forgetting the rest would cost the next session
 *  the head start this exists to give it. */
export function rememberWindows(windows: Readonly<Record<string, number>>) {
  const merged = { ...rememberedWindows() };
  let changed = false;
  for (const [id, value] of Object.entries(windows)) {
    if (typeof value !== "number" || value <= 0 || merged[id] === value) continue;
    merged[id] = value;
    changed = true;
  }
  if (!changed) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // A full or disabled store costs the next session its head start and
    // nothing else. The live figures never come from here.
  }
}
