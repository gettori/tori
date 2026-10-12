/** Mirrors `Kind` in src-tauri/src/needs_you_log.rs. */
export type NeedsYouKind = "permission" | "question" | "budget" | "waiting" | "workerQuestion" | "done" | "pullRequest";

/** Mirrors `Event` in src-tauri/src/needs_you_log.rs. */
export type NeedsYouEvent = {
  id: string;
  ts: number;
  session: string | null;
  folder: string;
  branch: string | null;
  project: string;
  title: string;
  kind: NeedsYouKind;
  resolvedAt: number | null;
  settled: boolean;
  chat: boolean;
};

const LABELS: Record<NeedsYouKind, string> = {
  permission: "Waiting for approval",
  question: "Asked a question",
  budget: "Stopped at its spend limit",
  waiting: "Waiting for you",
  workerQuestion: "A worker asked a question",
  done: "Finished",
  pullRequest: "Pull request needs attention",
};

export const kindLabel = (kind: NeedsYouKind) => LABELS[kind];

export const blocks = (kind: NeedsYouKind) => kind !== "done" && kind !== "pullRequest";

export const unanswered = (events: readonly NeedsYouEvent[]) => events.filter((e) => e.resolvedAt === null).length;

export type ProjectGroup = { project: string; events: NeedsYouEvent[] };

export function byProjectNewestFirst(events: readonly NeedsYouEvent[]): ProjectGroup[] {
  const groups = new Map<string, NeedsYouEvent[]>();
  for (const e of [...events].sort((a, b) => b.ts - a.ts)) {
    const list = groups.get(e.project);
    if (list) list.push(e);
    else groups.set(e.project, [e]);
  }
  return [...groups].map(([project, events]) => ({ project, events }));
}

export function eventTime(ts: number, now = Date.now()) {
  const at = new Date(ts);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? clock : `Yesterday ${clock}`;
}
