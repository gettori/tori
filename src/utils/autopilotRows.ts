import type {
  ActivityItem,
  Decision,
  DecisionKind,
  InFlightRow,
  QueuedItem,
  Ref,
  WorkerCard,
  WorkerStatus,
} from "../components/Autopilot/autopilot";
import type { AskApproval, SocketAsk } from "./socketAsks";
import { ago } from "./relativeTime";

/** Mirrors `Row` in src-tauri/src/autopilot.rs: an item with what was observed about it. */
export type ItemRow = {
  id: string;
  kind: "ship" | "review";
  source: { type: "issue"; key: string; project: string } | { type: "pr"; number: number; repo: string };
  project: string;
  state: "proposed" | "queued" | "running" | "waiting_on_you" | "taken_over" | "done" | "failed";
  worktree?: string | null;
  session?: string | null;
  created: number;
  updated: number;
  note?: string | null;
  title?: string | null;
  contract?: string | null;
  session_live?: boolean;
};

/** Mirrors `Hold` in src-tauri/src/rpc/asks.rs, as much of it as the rows read. */
export type Hold = { item: string; ask: string; question: string; asked_at: number };

/** One `autopilot.changed` payload, or one line of `log.jsonl`: an item, a contract, or (live only) a hold. */
export type AutopilotEvent = {
  ts: number;
  item?: ItemRow;
  project?: string;
  contract?: unknown;
  hold?: Hold;
  cleared?: boolean;
};

const STATE_WORDS: Record<ItemRow["state"], string> = {
  proposed: "proposed",
  queued: "queued",
  running: "running",
  waiting_on_you: "waiting on you",
  taken_over: "taken over",
  done: "done",
  failed: "failed",
};

const lastSegment = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export function itemRef(item: ItemRow): Ref {
  if (item.source.type === "pr") return item.source.number;
  return /^\d+$/.test(item.source.key) ? Number(item.source.key) : item.source.key;
}

const itemTitle = (item: ItemRow) =>
  item.title || `${item.kind === "review" ? "Review" : "Ship"} in ${lastSegment(item.project)}`;

const inFlight = (items: ItemRow[]) =>
  items.filter((i) => i.state === "running" || i.state === "waiting_on_you").sort((a, b) => a.created - b.created);

function workerStatus(item: ItemRow): WorkerStatus {
  if (item.state === "waiting_on_you") return "needs";
  return item.session_live === false ? "idle" : "working";
}

const doing = (item: ItemRow) => item.note || (item.state === "waiting_on_you" ? "Waiting on you" : "Running");

export const inFlightRows = (items: ItemRow[]): InFlightRow[] =>
  inFlight(items).map((i) => ({
    refNumber: itemRef(i),
    branch: i.worktree ? lastSegment(i.worktree) : "",
    status: workerStatus(i),
    doing: doing(i),
  }));

export const workerCards = (items: ItemRow[]): WorkerCard[] =>
  inFlight(items).map((i) => ({
    refNumber: itemRef(i),
    title: itemTitle(i),
    contract: i.contract ?? undefined,
    branch: i.worktree ? lastSegment(i.worktree) : "",
    diff: "",
    status: workerStatus(i),
    log: [],
    doing: doing(i),
  }));

export function queuedItems(items: ItemRow[]): QueuedItem[] {
  const queued = items.filter((i) => i.state === "queued").sort((a, b) => a.created - b.created);
  const flying = inFlight(items);
  const ahead = flying[flying.length - 1];
  return queued.map((i, n) => {
    const before = n > 0 ? queued[n - 1] : ahead;
    return { refNumber: itemRef(i), title: itemTitle(i), after: before && itemRef(before) };
  });
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function activityOf(e: AutopilotEvent, items: ItemRow[]): ActivityItem | null {
  const time = clock(e.ts);
  if (e.item) {
    const note = e.item.note ? `: ${e.item.note}` : "";
    return {
      time,
      text: `#${itemRef(e.item)} ${STATE_WORDS[e.item.state]}${note}`,
      needsYou: e.item.state === "waiting_on_you",
    };
  }
  if (e.hold && !e.cleared) {
    const item = items.find((i) => i.id === e.hold!.item);
    return { time, text: `${item ? `#${itemRef(item)} ` : ""}asks: ${e.hold.question}`, needsYou: true };
  }
  if (e.project !== undefined && e.contract !== undefined) {
    return { time, text: `Contract for ${lastSegment(e.project)} changed` };
  }
  return null;
}

const KIND_OF: Record<AskApproval["action"], DecisionKind> = { "pr.create": "pr", "review.submit": "review", "pr.merge": "merge" };

export function decisionOf(ask: SocketAsk, items: ItemRow[], holds: Hold[], asker: (session: string) => string): Decision {
  const approval = ask.approval ?? null;
  const item = items.find((i) => i.id === ask.item);
  const number = approval && "number" in approval ? approval.number : undefined;
  const refNumber = number ?? (item && itemRef(item));
  const asked = holds.find((h) => h.ask === ask.id)?.asked_at;
  return {
    id: ask.id,
    kind: approval ? KIND_OF[approval.action] : "question",
    refNumber,
    refKind: number !== undefined || item?.source.type === "pr" ? "pr" : "issue",
    title: approval?.action === "pr.create" ? approval.title : lastSegment(approval?.project ?? item?.project ?? ""),
    summary: ask.question,
    age: asked ? ago(Math.floor(asked / 1000)) : "",
    worker: approval ? undefined : asker(ask.session),
  };
}
