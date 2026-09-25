// What every live session is doing right now.
//
// This was ~200 lines of LeftSidebar's closure. It never belonged there: the
// composition reads nothing the tree owns, and Phase 5's History panel needs
// the same answer without mounting a sidebar. `chatSessions.ts` is the model - a module-level store the surfaces
// read, rather than state a panel lends out.
//
// **Rust composes every dot** (`rpc/dots.rs`, pinned by the golden fixtures
// there) from the facts this module reports and what Rust measures itself, and
// hands the result back on `sessions://dots`. A chat's own status is still read
// here, raw, because the revert guard has to see a turn start on the same tick.
import { createSignal, createMemo, createEffect, createRoot } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LiveTab } from "./events";
import { sessions, type SessionMeta } from "./sessionStore";
import { liveChats, liveChatIds, type LiveChat } from "./chatSessions";
import {
  statusFromDot,
  type SessionDot,
  type SessionHome,
  type SessionStatus,
  type LiveSessionStatus,
  type StatusCertainty,
} from "./sessionStatus";

/** Which space and project owns a branch-unit folder. Display metadata for a
 *  live status, which the store cannot work out for itself. */
export type FolderOwner = { spaceName: string; projectName: string };

/** One branch-unit as the CI attribution needs it: enough for Rust to place a
 *  session under it, plus whether its pull request is in a state worth
 *  someone's attention.
 *
 *  Fed rather than derived because the forge status is keyed by *project path*
 *  and a session knows only its folder; only the sidebar holds both. The shape
 *  deliberately carries no dot and no status, so the effect that produces it
 *  cannot end up reading the dots it is about to change. */
export type ForgeUnit = {
  kind: string;
  branch: string | null;
  isCurrent: boolean;
  folderPath: string;
  /** The project the unit belongs to. A worktree project's units each have
   *  their own folder, so the folder alone cannot group siblings, and the
   *  branch a pull request names is only unique within one project. */
  projectPath: string;
  attention: boolean;
};

// --- fed inputs -------------------------------------------------------------

const [liveTabs, setLiveTabs] = createSignal<readonly LiveTab[]>([]);
const [folderOwners, setFolderOwners] = createSignal<Record<string, FolderOwner>>({});
const [forgeUnits, setForgeUnits] = createSignal<readonly ForgeUnit[]>([]);

/** The tab set, from whoever owns it (App, through the sidebar). */
export function noteLiveTabs(tabs: readonly LiveTab[]) {
  setLiveTabs(tabs);
}

/** folderPath -> owning space and project, rebuilt whenever the config does. */
export function noteFolderOwners(owners: Record<string, FolderOwner>) {
  setFolderOwners(owners);
}

/** The sidebar's current selection, and whether the window has focus. Together
 *  they are "you are looking at this", which Rust reads to decide what counts
 *  as attended and which needs-you edges are worth a notification. */
export function noteAttention(sessionId: string | null, focused: boolean) {
  invoke("rpc_attention", { session: sessionId, focused }).catch(() => {});
}

/** Every watched branch-unit and whether its pull request wants looking at.
 *  Rebuilt whenever the forge answers or the tree changes. */
export function noteForgeUnits(units: readonly ForgeUnit[]) {
  setForgeUnits(units);
}

// --- owned state ------------------------------------------------------------

// Per-session probe cache for the row status dot: last known liveness, keyed by
// session id, plus the agent used (so a later re-probe of a detached session
// does not need a session-store lookup). Probing is trigger-driven only (row
// selection, sessions://changed, window focus) - never a periodic pgrep.
const [probes, setProbes] = createSignal<Record<string, { agent: string; running: boolean }>>({});

// What Rust last composed per session: the dot, how it knows it, and the unit
// row the session sits under.
export type RustDot = { id: string; dot: SessionDot; certainty: StatusCertainty; home: SessionHome | null };
const [rustDots, setRustDots] = createSignal<Record<string, RustDot>>({});

export function noteDots(changes: readonly RustDot[] | undefined) {
  if (!changes?.length) return;
  setRustDots((m) => {
    const next = { ...m };
    for (const c of changes) next[c.id] = c;
    return next;
  });
}

/** Probe a set of sessions at once. Every id asked about is recorded, including
 *  the ones that came back absent, so a session that has since exited flips to
 *  false rather than keeping its last answer. */
export async function probeBatch(want: readonly { id: string; agent: string }[]) {
  const running = new Set(
    await invoke<string[]>("sessions_running", { sessions: want }).catch(() => [] as string[]),
  );
  setProbes((m) => {
    const next = { ...m };
    for (const w of want) next[w.id] = { agent: w.agent, running: running.has(w.id) };
    return next;
  });
}

export const probeSession = (id: string, agent: string) => probeBatch([{ id, agent }]);

/** Re-probe every session whose dot could currently be non-"none": every live
 *  tab's session (catches solid -> none, e.g. a Ctrl+C exit-to-shell) and every
 *  previously-confirmed detached session (catches hollow -> none, e.g. it
 *  exited). Called from sessions://changed and window focus only. */
export function probeActive() {
  const seen = new Set<string>();
  const want: { id: string; agent: string }[] = [];
  for (const t of liveTabs()) {
    if (!t.sessionId || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    want.push({ id: t.sessionId, agent: t.agent ?? probes()[t.sessionId]?.agent ?? "claude" });
  }
  for (const [id, p] of Object.entries(probes())) {
    if (p.running && !seen.has(id)) {
      seen.add(id);
      want.push({ id, agent: p.agent });
    }
  }
  // One call for the whole set: this fires on every sessions://changed, so a
  // probe per session made a busy window pay a subprocess per open tab.
  if (want.length > 0) void probeBatch(want);
}

// --- composition ------------------------------------------------------------

/// The project `root` belongs to, or null when no unit list places it.
///
/// `root` is whatever directory the caller happens to be looking at. For a plain
/// project that is the project's own path; for a worktree project it is one
/// unit's checkout, which is *not* the project path. Everything keyed per
/// project (the poll's statuses, its uncovered count) has to be looked up under
/// this rather than under the directory on screen, or a worktree checkout reads
/// as a project nothing has ever polled.
export function projectPathFor(root: string): string | null {
  const all = forgeUnits();
  return (
    all.find((u) => u.folderPath === root)?.projectPath ??
    (all.some((u) => u.projectPath === root) ? root : null)
  );
}

/// The branch-unit of `root`'s project that carries `branch`, or null.
export function projectUnitFor(root: string, branch: string): ForgeUnit | null {
  const projectPath = projectPathFor(root);
  if (projectPath === null || !branch) return null;
  return forgeUnits().find((u) => u.projectPath === projectPath && u.branch === branch) ?? null;
}

/** One branch-unit and the session that speaks for it. */
export type BranchOwner = { folderPath: string; session: SessionMeta };

/// Who to hand a remark about `branch` to: the most recently active session of
/// the unit that carries it, or null when no unit does or nothing has ever run
/// there.
///
/// `root` is whatever directory the caller happens to be looking at. For a plain
/// project that is the project's own path; for a worktree project it is one
/// unit's checkout, which is *not* the project path, so the project is found
/// through the unit list rather than assumed to equal `root`.
///
/// The attribution is Rust's, the same one the sidebar's rollup badges read. A
/// plain repo's sibling units share one folder and are told apart only by the
/// branch a session recorded, so a second rule here is how a review comment on
/// `feat` ends up in the agent working on `main`.
///
/// Most recently active, not "the live one": a session with no tab open is still
/// the one that wrote the branch, and safe-send resumes it. Picking a live
/// session instead would hand the remark to whichever tab happened to be open.
export function branchOwner(root: string, branch: string): BranchOwner | null {
  const unit = projectUnitFor(root, branch);
  if (!unit) return null;
  const mine = (sessions()[unit.folderPath] ?? []).filter((s) => inUnit(s.home, unit));
  const owner = mine.reduce<SessionMeta | null>(
    (best, s) => (best === null || s.last_active > best.last_active ? s : best),
    null,
  );
  return owner ? { folderPath: unit.folderPath, session: owner } : null;
}

/** Whether a session whose unit row is `home` sits under `unit`. */
export function inUnit(home: SessionHome | null | undefined, unit: { folderPath: string; branch: string | null }): boolean {
  return !!home && home.folder === unit.folderPath && (home.branch ?? null) === (unit.branch ?? null);
}

export function sessionDot(id: string): SessionDot {
  return rustDots()[id]?.dot ?? "none";
}

/** Whether this session's status was measured or inferred, for the marker the
 *  row renders. Only the exact side is marked. */
export function sessionCertainty(id: string): StatusCertainty {
  return rustDots()[id]?.certainty ?? "inferred";
}

// A chat's own status, raised only where a red check can raise it. Not routed
// through the dot, which would flatten `budgetStopped` into an approval that
// does not exist, and would lag the turn the revert guard must see at once.
function chatStatus(c: LiveChat): SessionStatus {
  const raised = (c.status === "idle" || c.status === "running") && sessionDot(c.sessionId) === "needsYou";
  return raised ? "waitingForApproval" : c.status;
}

export function sessionStatus(id: string): SessionStatus {
  const chat = liveChats().find((c) => c.sessionId === id);
  return chat ? chatStatus(chat) : statusFromDot(sessionDot(id));
}

const homeOf = (id: string, meta: SessionMeta | undefined) => rustDots()[id]?.home ?? meta?.home ?? null;

// The same set in the status vocabulary, covering every space rather than the
// active one. This is what the rollup badges, the revert guard and the editor's
// diff gate all read, so both tiers belong in it: a chat that is waiting is
// waiting on exactly the same terms as a blocked PTY agent, and a consumer that
// had to union the two lists itself would be a second place for them to
// disagree. `home` is the unit row Rust placed the session under, and `agent`
// comes from the session store, since a tab descriptor carries neither.
const liveSessionStatuses = createMemo<LiveSessionStatus[]>(() => {
  const all = Object.values(sessions()).flat();
  const live: LiveSessionStatus[] = [];
  for (const t of liveTabs()) {
    if (t.kind !== "agent" || !t.sessionId) continue;
    const meta = all.find((s) => s.id === t.sessionId);
    const owner = folderOwners()[t.workspace];
    live.push({
      sessionId: t.sessionId,
      status: sessionStatus(t.sessionId),
      sessionName: meta?.name || meta?.title || t.sessionId,
      spaceName: owner?.spaceName ?? "",
      projectName: owner?.projectName ?? "",
      folderPath: t.workspace,
      tabId: t.id,
      home: homeOf(t.sessionId, meta),
      agent: meta?.agent,
    });
  }
  for (const c of liveChats()) {
    const meta = all.find((s) => s.id === c.sessionId);
    const owner = folderOwners()[c.folderPath];
    live.push({
      sessionId: c.sessionId,
      status: chatStatus(c),
      sessionName: c.sessionName,
      spaceName: owner?.spaceName ?? "",
      projectName: owner?.projectName ?? "",
      folderPath: c.folderPath,
      tabId: c.tabId,
      home: homeOf(c.sessionId, meta),
      agent: meta?.agent,
    });
  }
  return live;
});

export { liveSessionStatuses };

export function sessionFacts() {
  const tabs = liveTabs()
    .filter((t) => t.kind === "agent" && t.sessionId)
    .map((t) => ({ id: t.id, session: t.sessionId!, live: t.state === "live", workspace: t.workspace, agent: t.agent }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chats = liveChats()
    .map((c) => ({
      session: c.sessionId,
      status: c.status,
      folder: c.folderPath,
      visible: c.visible,
      spawner: c.spawner,
      name: c.sessionName,
    }))
    .sort((a, b) => a.session.localeCompare(b.session));
  const forge = forgeUnits().map(({ folderPath, kind, branch, isCurrent, attention }) => ({
    folderPath,
    kind,
    branch,
    isCurrent,
    attention,
  }));
  return { tabs, chats, forge };
}

/** Whether the editor should poll `sessionId`'s accumulated diff.
 *
 *  Executing, **and not a chat**. The status list covers both tiers now, but a
 *  chat renders its own diff per tool call straight from its event stream;
 *  polling underneath it would be a second, slower answer to a question already
 *  answered exactly. `liveChatIds()` is the discriminator rather than a tier
 *  field on the status, because it already exists and the status type is shared
 *  with surfaces that have no reason to care which tier a session is. */
export function shouldPollAccumulatedDiff(sessionId: string | null | undefined): boolean {
  if (!sessionId || liveChatIds().has(sessionId)) return false;
  return liveSessionStatuses().some((s) => s.sessionId === sessionId && s.status === "executing");
}

// One app-lifetime root: Rust needs the facts whether or not the sidebar is
// mounted, and there is nothing to dispose short of the app closing.
createRoot(() => {
  // Listening before the fetch, so no change can land in between and be lost.
  void Promise.resolve()
    .then(() => listen<RustDot[]>("sessions://dots", (e) => noteDots(e.payload)))
    .then(() => invoke<RustDot[]>("session_dots"))
    .then(noteDots)
    .catch(() => {});

  let pushed = "";
  createEffect(() => {
    const facts = sessionFacts();
    const key = JSON.stringify(facts);
    if (key === pushed) return;
    pushed = key;
    invoke("rpc_session_facts", { facts }).catch(() => {});
  });
});

/** Drop every measurement. Test support, named so it cannot be mistaken for
 *  part of the store's real API: this state is app-lifetime, so without it a
 *  test that renders twice inherits the first render's probes and tails. */
export function resetSessionActivityForTests() {
  setProbes({});
  setRustDots({});
  setLiveTabs([]);
  setFolderOwners({});
  setForgeUnits([]);
}
