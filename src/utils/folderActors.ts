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
import { liveChatIds, liveChats } from "./chatSessions";
import type { RevertCandidate } from "./revertGuard";

type SessionMeta = { id: string; agent: string; cwd: string; name?: string; title?: string };

/** Sessions Sway hosts in a tab of its own, whose status it knows rather than
 *  probes: PTY agent tabs (composed from activity + transcript tail) and chat
 *  tabs (reported by the transport's own event stream). */
export function liveCandidates(): RevertCandidate[] {
  const pty = liveStatuses().map((s) => ({
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    folderPath: s.folderPath,
    status: s.status,
    hasLiveTab: true,
  }));
  const chat = liveChats().map((c) => ({
    sessionId: c.sessionId,
    sessionName: c.sessionName,
    folderPath: c.folderPath,
    status: c.status,
    hasLiveTab: true,
  }));
  return [...pty, ...chat];
}

/** Every session rooted in this folder that Sway cannot see inside: found by
 *  list_sessions, absent from the live-tab set, and confirmed alive by the
 *  pgrep probe. Their status tops out at "running" - a detached process can
 *  never report Executing.
 *
 *  Chat-hosted ids are excluded here: reporting one twice would downgrade a
 *  session whose exact status we have into an overridable "cannot verify".
 *
 *  The exclusion is what makes that correct, and it does not rest on the probe
 *  agreeing. It used to be justified by "a chat's child answers that same pgrep
 *  probe", which was measured false in Phase 12 - the adapter's pattern wanted
 *  the flag adjacent to the program name, and a chat puts its base_args first,
 *  so no chat matched at all. The pattern is fixed, but the reasoning here
 *  deliberately no longer depends on it. */
export async function detachedCandidates(folder: string): Promise<RevertCandidate[]> {
  const sessions = await invoke<SessionMeta[]>("list_sessions", { folder }).catch(() => [] as SessionMeta[]);
  const liveIds = new Set([...liveStatuses().map((s) => s.sessionId), ...liveChatIds()]);
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
