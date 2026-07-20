// Who could be writing in a folder right now, as the two tiers the revert guard
// distinguishes. Extracted from CheckpointTimeline so the live "editing now"
// indicator tests sole-authorship against exactly the same set the revert guard
// blocks on: one definition of "actor", so the two features can never disagree
// about whether a folder is busy.
//
// The detached tier costs a `list_sessions` plus a `session_running` probe per
// off-tab session, so callers gather deliberately (at click time, or on a turn
// boundary) rather than per event.
import { invoke } from "@tauri-apps/api/core";
import { liveStatuses } from "./sessionStatus";
import type { RevertCandidate } from "./revertGuard";

type SessionMeta = { id: string; agent: string; cwd: string; name?: string; title?: string };

/** Sessions Sway hosts in a live agent tab, whose status it composes itself. */
export function liveCandidates(): RevertCandidate[] {
  return liveStatuses().map((s) => ({
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    folderPath: s.folderPath,
    status: s.status,
    hasLiveTab: true,
  }));
}

/** Every session rooted in this folder that Sway cannot see inside: found by
 *  list_sessions, absent from the live-tab set, and confirmed alive by the
 *  pgrep probe. Their status tops out at "running" - a detached process can
 *  never report Executing. */
export async function detachedCandidates(folder: string): Promise<RevertCandidate[]> {
  const sessions = await invoke<SessionMeta[]>("list_sessions", { folder }).catch(() => [] as SessionMeta[]);
  const liveIds = new Set(liveStatuses().map((s) => s.sessionId));
  const offTab = sessions.filter((s) => !liveIds.has(s.id));
  const probes = await Promise.all(
    offTab.map(async (s) => ({
      session: s,
      running: await invoke<boolean>("session_running", { id: s.id, agent: s.agent }).catch(() => false),
    })),
  );
  return probes
    .filter((p) => p.running)
    .map((p) => ({
      sessionId: p.session.id,
      sessionName: p.session.name || p.session.title || p.session.id.slice(0, 8),
      folderPath: p.session.cwd,
      status: "running" as const,
      hasLiveTab: false,
    }));
}

/** Both tiers together: everything that could be mid-turn in `folder`. */
export async function folderActors(folder: string): Promise<RevertCandidate[]> {
  return [...liveCandidates(), ...(await detachedCandidates(folder))];
}
