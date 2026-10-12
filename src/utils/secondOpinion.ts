// A second opinion: another agent reviews a session's work since its review
// mark, read-only, and its findings come back as held comments in the diff.
// Rust runs the reviewer and keeps the findings; this side picks who reviews,
// starts it, and turns stored findings into held comments.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enabledChatAgents } from "./agentEnabled";
import { findAdapter } from "./agents";
import { emitWith, TOAST, type ToastEvent } from "./events";
import type { HeldComment } from "./heldComments";
import { isUnderPath } from "./pathScope";
import { rowLabel, soleProfile } from "./projectAgents";
import { sendTargetFor } from "./sendTarget";
import type { SessionMeta } from "./sessionStore";
import { saveSettings, settings, type AgentRow } from "../panels/Settings/settingsStore";

const CHANGED_EVENT = "second-opinion://changed";

export type FindingStatus = "open" | "sent" | "dismissed";

type Finding = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
  status: FindingStatus;
  stale: boolean;
};

export type ReviewView = {
  session: string;
  author: SessionMeta | null;
  reviewer: string;
  ts: number;
  error: string | null;
  findings: Finding[];
};

const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set());
const [version, setVersion] = createSignal(0);

/** Bumps whenever a review starts, ends or a finding's status changes. */
export const reviewsVersion = version;

export function secondOpinionRunning(sessionId: string): boolean {
  return running().has(sessionId);
}

let reviewers: Promise<string[]> | undefined;
function reviewerAgents(): Promise<string[]> {
  reviewers ??= invoke<string[]>("second_opinion_reviewers").catch(() => []);
  return reviewers;
}

/** Agents that can review: a read-only mode Tori can confirm, and enabled here. */
export async function reviewerChoices(): Promise<string[]> {
  const ids = await reviewerAgents();
  return enabledChatAgents()
    .map((a) => a.id)
    .filter((id) => ids.includes(id));
}

/** The pick the project holding `folder` stores. The deepest project wins. */
export function storedReviewer(folder: string): AgentRow | null {
  let best: { path: string; row: AgentRow } | null = null;
  for (const [path, row] of Object.entries(settings.secondOpinion ?? {})) {
    if (isUnderPath(folder, path) && (!best || path.length > best.path.length)) best = { path, row };
  }
  return best?.row ?? null;
}

export function setStoredReviewer(projectPath: string, row: AgentRow | null): Promise<void> {
  const next = { ...settings.secondOpinion };
  if (row) next[projectPath] = row;
  else delete next[projectPath];
  return saveSettings({ ...settings, secondOpinion: next });
}

/** Who reviews a session by `author` in `folder`, or why nobody can. */
export async function reviewerFor(folder: string, author: string): Promise<AgentRow | { reason: string }> {
  const choices = await reviewerChoices();
  const stored = storedReviewer(folder);
  if (stored) {
    return choices.includes(stored.agent)
      ? stored
      : { reason: `${findAdapter(stored.agent).label} is set to give second opinions here, but it isn't available` };
  }
  const id = choices.find((c) => c !== author);
  if (!id) return { reason: "No other agent with a read-only mode is enabled, so nobody can give a second opinion." };
  return { agent: id, profile: soleProfile(id) };
}

const toast = (message: string, kind: ToastEvent["kind"] = "error") => emitWith<ToastEvent>(TOAST, { message, kind });

const startedHere = new Map<string, string>();

export async function runSecondOpinion(session: Pick<SessionMeta, "id" | "cwd" | "agent">) {
  const pick = await reviewerFor(session.cwd, session.agent ?? "claude");
  if ("reason" in pick) return toast(pick.reason);
  try {
    await invoke("second_opinion_run", { session: session.id, agent: pick.agent, profile: pick.profile });
    startedHere.set(session.id, session.cwd);
    toast(`${rowLabel(pick.agent, pick.profile)} is giving a second opinion`, "info");
  } catch (e) {
    toast(String(e));
  }
}

export function listReviews(folder: string): Promise<ReviewView[]> {
  return invoke<ReviewView[] | null>("second_opinion_list", { folder })
    .then((r) => r ?? [])
    .catch(() => []);
}

export async function setFindingStatus(folder: string, session: string, ids: string[], status: FindingStatus) {
  if (!ids.length) return;
  await invoke("second_opinion_set_status", { folder, session, ids, status }).catch((e) => toast(String(e)));
}

/** A review's open findings as held comments, each carrying its own target. */
export function heldFromReviews(reviews: readonly ReviewView[]): HeldComment[] {
  return reviews.flatMap((r) => {
    const gate = r.author
      ? sendTargetFor({
          agent: r.author.agent,
          profile: r.author.profile ?? null,
          sessionId: r.author.id,
          sessionPath: r.author.path,
          sessionFile: r.author.path,
          sessionCwd: r.author.cwd,
          sessionTitle: r.author.title,
          folderPath: r.author.cwd,
        })
      : { reason: "The reviewed session is gone" };
    const author = findAdapter(r.reviewer).label;
    return r.findings
      .filter((f) => f.status === "open")
      .map((f) => ({
        id: f.id,
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        text: f.body,
        author,
        session: r.session,
        stale: f.stale,
        ...("target" in gate ? { target: gate.target } : { blocked: gate.reason }),
      }));
  });
}

async function refreshRunning() {
  const ids = await invoke<string[]>("second_opinion_running").catch(() => null);
  if (!ids) return;
  const now = new Set(ids);
  for (const [id, folder] of startedHere) {
    if (now.has(id)) continue;
    startedHere.delete(id);
    void announce(id, folder);
  }
  setRunning(now);
}

async function announce(session: string, folder: string) {
  const review = (await listReviews(folder)).find((r) => r.session === session);
  if (!review) return;
  if (review.error) return toast(`Second opinion failed: ${review.error}`);
  const open = review.findings.filter((f) => f.status === "open").length;
  const who = findAdapter(review.reviewer).label;
  toast(
    open
      ? `${who} left ${open === 1 ? "1 comment" : `${open} comments`}, held in the session's diff`
      : `${who} found nothing worth raising`,
    "info",
  );
}

let started = false;

export function watchSecondOpinions() {
  if (started) return;
  started = true;
  void refreshRunning();
  void listen(CHANGED_EVENT, () => {
    setVersion((v) => v + 1);
    void refreshRunning();
  });
}
