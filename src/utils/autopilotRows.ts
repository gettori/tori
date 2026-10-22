import type {
  ActivityItem,
  AutopilotState,
  CockpitHero,
  Decision,
  DecisionKind,
  InFlightRow,
  QueuedItem,
  RuleCard,
  ScheduleCard,
  TicketRef,
  WorkerCard,
  WorkerStatus,
} from "../components/Autopilot/autopilot";
import type { AskApproval, SocketAsk } from "./socketAsks";
import type { PrEvent } from "../panels/Settings/settingsStore";
import { ago } from "./relativeTime";
import { sameFolder } from "./autopilotContracts";
import type { NavTarget } from "./events";

/** Mirrors `Reference` in src-tauri/src/autopilot.rs. */
export type Reference = TicketRef & { pr?: { label: string; url: string }; target: NavTarget; markdown: string };

/** Mirrors `Row` in src-tauri/src/autopilot.rs: an item with what was observed about it. */
export type ItemRow = {
  id: string;
  kind: "ship" | "review";
  source:
    | { type: "issue"; key: string; project: string }
    | { type: "pr"; number: number; repo: string }
    | { type: "schedule"; schedule: string; issue?: string }
    | { type: "rule"; pr: number; repo: string; event: PrEvent };
  project: string;
  state: "proposed" | "queued" | "running" | "waiting_on_you" | "taken_over" | "done" | "failed";
  worktree?: string | null;
  session?: string | null;
  pr_url?: string | null;
  url?: string | null;
  created: number;
  updated: number;
  note?: string | null;
  title?: string | null;
  contract?: string | null;
  session_live?: boolean;
  worktree_gone?: boolean;
  /** Pushes made without asking under the project's fix loop. */
  fix_pushes?: { sha: string; at: number }[];
  /** Who stopped the item's fix loop with a review or comment. */
  fix_stopped?: string;
  /** Derived per read; absent on an item read back from `log.jsonl`. */
  reference?: Reference;
};

/** Mirrors `ScheduleRow` in src-tauri/src/autopilot/schedules.rs. */
export type ScheduleRow = {
  id: string;
  name: string;
  project: string;
  cron: string;
  what: { type: "prompt"; text: string } | { type: "issue"; key: string };
  created: number;
  last_slot?: number | null;
  resumed_at?: number | null;
  next_run?: number | null;
  paused: boolean;
};

/** Mirrors `RuleRow` in src-tauri/src/autopilot.rs. */
export type RuleRow = {
  project: string;
  on: PrEvent[];
  max_per_hour: number;
  fired_this_hour: number;
  paused: boolean;
};

/** Mirrors `Hold` in src-tauri/src/rpc/asks.rs, as much of it as the rows read. */
export type Hold = { item: string; ask: string; question: string; asked_at: number };

/** One `autopilot.changed` payload, or one line of `log.jsonl`: an item, a contract, or (live only) a hold. */
export type AutopilotEvent = {
  ts: number;
  item?: ItemRow;
  schedule?: ScheduleRow;
  schedule_removed?: string;
  rule_resumed?: string;
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

// An item from the log was written before any reference was derived, so it
// reads by its number alone.
export function ticketOf(item: ItemRow): TicketRef {
  if (item.reference) return item.reference;
  if (item.source.type === "schedule") return { label: item.title ?? item.source.schedule, place: [] };
  if (item.source.type === "rule") return { label: `#${item.source.pr}`, place: [] };
  const key = item.source.type === "pr" ? String(item.source.number) : item.source.key.replace(/^#/, "");
  return { label: /^\d+$/.test(key) ? `#${key}` : key, place: [] };
}

// A change names only what it knows: `session_live` and `worktree_gone` come
// from a full read, so a row keeps the last ones until the next.
export function applyItem(prev: ItemRow[], item: ItemRow): ItemRow[] {
  return prev.some((i) => i.id === item.id)
    ? prev.map((i) => (i.id === item.id ? { ...i, ...item } : i))
    : [...prev, item];
}

const itemTitle = (item: ItemRow) =>
  item.title || `${item.kind === "review" ? "Review" : "Ship"} in ${lastSegment(item.project)}`;

const inFlight = (items: ItemRow[]) =>
  items.filter((i) => i.state === "running" || i.state === "waiting_on_you").sort((a, b) => a.created - b.created);

function workerStatus(item: ItemRow): WorkerStatus {
  if (item.state === "waiting_on_you") return "needs";
  return item.session_live === false ? "idle" : "working";
}

/** The project's fix attempts, null where its fix loop is off. */
export type AttemptsOf = (project: string) => number | null;

export function fixMark(item: ItemRow, attempts: number | null): string | null {
  if (attempts === null || item.kind !== "ship" || !item.pr_url) return null;
  const count = `fix ${item.fix_pushes?.length ?? 0}/${attempts}`;
  return item.fix_stopped ? `${count}, stopped by @${item.fix_stopped}` : count;
}

const doing = (item: ItemRow, attemptsOf: AttemptsOf) => {
  const said = item.note || (item.state === "waiting_on_you" ? "Waiting on you" : "Running");
  const fix = fixMark(item, attemptsOf(item.project));
  return fix ? `${said}, ${fix}` : said;
};

const noLoop: AttemptsOf = () => null;

export const inFlightRows = (items: ItemRow[], attemptsOf: AttemptsOf = noLoop): InFlightRow[] =>
  inFlight(items).map((i) => ({
    ticket: ticketOf(i),
    status: workerStatus(i),
    doing: doing(i, attemptsOf),
  }));

export const workerCards = (items: ItemRow[], attemptsOf: AttemptsOf = noLoop): WorkerCard[] =>
  inFlight(items).map((i) => ({
    ticket: ticketOf(i),
    title: itemTitle(i),
    contract: i.contract ?? undefined,
    diff: "",
    status: workerStatus(i),
    log: [],
    doing: doing(i, attemptsOf),
  }));

export function queuedItems(items: ItemRow[]): QueuedItem[] {
  const queued = items.filter((i) => i.state === "queued").sort((a, b) => a.created - b.created);
  const flying = inFlight(items);
  const ahead = flying[flying.length - 1];
  const lined = queued.map((i, n) => {
    const before = n > 0 ? queued[n - 1] : ahead;
    return { ticket: ticketOf(i), title: itemTitle(i), after: before && ticketOf(before) };
  });
  const proposed = items.filter((i) => i.state === "proposed").sort((a, b) => a.created - b.created);
  return [...lined, ...proposed.map((i) => ({ ticket: ticketOf(i), title: itemTitle(i), proposed: true }))];
}

function blockingItem(s: ScheduleRow, items: ItemRow[]): ItemRow | undefined {
  const open = items.filter((i) => i.state !== "done" && i.state !== "failed" && sameFolder(i.project, s.project));
  const key = s.what.type === "issue" ? s.what.key.toLowerCase() : undefined;
  return open.find(
    (i) =>
      (i.source.type === "schedule" && i.source.schedule === s.id) ||
      (key !== undefined &&
        ((i.source.type === "issue" && i.source.key.toLowerCase() === key) ||
          (i.source.type === "schedule" && i.source.issue?.toLowerCase() === key))),
  );
}

const nextAt = (ms: number) =>
  new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function scheduleCards(rows: ScheduleRow[], items: ItemRow[], now = Date.now()): ScheduleCard[] {
  return rows.map((s) => {
    const finished = items
      .filter((i) => i.source.type === "schedule" && i.source.schedule === s.id)
      .filter((i) => i.state === "done" || i.state === "failed")
      .sort((a, b) => b.updated - a.updated)[0];
    const open = blockingItem(s, items);
    return {
      id: s.id,
      name: s.name,
      cron: s.cron,
      what: s.what.type === "prompt" ? s.what.text : `issue ${s.what.key}`,
      next: s.next_run ? nextAt(s.next_run) : undefined,
      last: finished && `${finished.state} ${ago(Math.floor(finished.updated / 1000), Math.floor(now / 1000))} ago`,
      paused: s.paused,
      waitingOn: open && ticketOf(open),
    };
  });
}

const EVENT_WORDS: Record<PrEvent, string> = {
  changes_requested: "changes requested",
  check_failed: "a failed check",
  conflicting: "a conflict",
};

export function ruleCards(rows: RuleRow[]): RuleCard[] {
  return rows.map((r) => ({
    project: r.project,
    name: lastSegment(r.project),
    on: `on ${r.on.map((e) => EVENT_WORDS[e]).join(", ")}`,
    fired: `${r.fired_this_hour} of ${r.max_per_hour} this hour`,
    paused: r.paused,
  }));
}

export function applySchedule(prev: ScheduleRow[], e: AutopilotEvent): ScheduleRow[] {
  if (e.schedule_removed) return prev.filter((s) => s.id !== e.schedule_removed);
  const row = e.schedule;
  if (!row) return prev;
  return prev.some((s) => s.id === row.id) ? prev.map((s) => (s.id === row.id ? row : s)) : [...prev, row];
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function activityOf(e: AutopilotEvent, items: ItemRow[]): ActivityItem | null {
  const time = clock(e.ts);
  if (e.item) {
    const note = e.item.note ? `: ${e.item.note}` : "";
    const current = items.find((i) => i.id === e.item!.id);
    return {
      time,
      ticket: ticketOf(current ?? e.item),
      text: `${STATE_WORDS[e.item.state]}${note}`,
      needsYou: e.item.state === "waiting_on_you",
    };
  }
  if (e.hold && !e.cleared) {
    const item = items.find((i) => i.id === e.hold!.item);
    return { time, ticket: item && ticketOf(item), text: `asks: ${e.hold.question}`, needsYou: true };
  }
  if (e.project !== undefined && e.contract !== undefined) {
    return { time, text: `Contract for ${lastSegment(e.project)} changed` };
  }
  return null;
}

const KIND_OF: Record<AskApproval["action"], DecisionKind> = {
  "pr.create": "pr",
  "review.submit": "review",
  "pr.push": "push",
  "pr.merge": "merge",
};

export function decisionOf(
  ask: SocketAsk,
  items: ItemRow[],
  holds: Hold[],
  asker: (session: string) => string,
): Decision {
  const approval = ask.approval ?? null;
  const item = items.find((i) => i.id === ask.item);
  const number = approval && "number" in approval ? approval.number : undefined;
  // The item's own ticket over the approval's PR number, so one ticket reads
  // one way across the cockpit; its PR shows beside it.
  const ticket = item ? ticketOf(item) : number !== undefined ? { label: `#${number}`, place: [] } : undefined;
  const asked = holds.find((h) => h.ask === ask.id)?.asked_at;
  return {
    id: ask.id,
    kind: approval ? KIND_OF[approval.action] : "question",
    ticket,
    refKind: item
      ? item.source.type === "pr" || item.source.type === "rule"
        ? "pr"
        : "issue"
      : number !== undefined
        ? "pr"
        : undefined,
    pr: item?.reference?.pr,
    title: approval?.action === "pr.create" ? approval.title : lastSegment(approval?.project ?? item?.project ?? ""),
    summary: ask.question,
    age: asked ? ago(Math.floor(asked / 1000)) : "",
    worker: approval ? undefined : asker(ask.session),
  };
}

const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const counted = (n: number, one: string, many: string) => `${COUNT[n] ?? n} ${n === 1 ? one : many}`;

const waitBelow = (crew: number) =>
  crew === 0
    ? ""
    : crew === 1
      ? " The worker waits below."
      : crew === 2
        ? " Both workers wait below."
        : " The crew waits below.";

function onDeck(crew: number, queued: number): string {
  const deck = crew ? `${counted(crew, "worker", "workers")} on deck` : "Nobody on deck yet";
  return queued ? `${deck} and ${counted(queued, "waiting", "waiting").toLowerCase()} at the dock.` : `${deck}.`;
}

/** More workers out than the chat limit allows, which the cockpit shows as a storm. Zero is no limit. */
export const overLimit = (crew: number, limit: number) => limit > 0 && crew > limit;

/** The banner's words for where the autopilot stands. */
export function heroFor(
  state: AutopilotState,
  calls: number,
  crew: number,
  queued: number,
  limit: number,
): CockpitHero {
  if ((state === "working" || state === "idle") && overLimit(crew, limit)) {
    return {
      eyebrow: "Rough seas",
      title: "The crew is stretched thin.",
      body: `${onDeck(crew, queued)} That is past your limit of ${limit} running chats, so expect a slower voyage.`,
    };
  }
  // The autopilot's own turn can be over while its workers still run.
  if (state === "idle" && crew > 0) state = "working";
  switch (state) {
    case "needs":
      return {
        eyebrow: "Holding course",
        title: `${counted(calls, "call", "calls")} for the captain.`,
        body: `The ship holds its heading while you decide.${waitBelow(crew)}`,
      };
    case "working":
      return {
        eyebrow: "Cruising",
        title: "Smooth sailing.",
        body: `${onDeck(crew, queued)} Kick back, the autopilot rings when it needs you.`,
      };
    case "idle":
      return {
        eyebrow: "Anchored",
        title: "Anchored in a calm bay.",
        body: "Nothing on deck. Hand the autopilot a ticket or a PR and it sets sail.",
      };
    case "error":
      return {
        eyebrow: "Choppy water",
        title: "A squall passed through.",
        body: "The autopilot session dropped. Restart it when you are ready, the crew keeps working.",
      };
    case "off":
      return {
        eyebrow: "Docked",
        title: "In harbor.",
        body: "Workers it started are normal sessions now. Set sail to hand the autopilot tickets and PRs.",
      };
  }
}

export function decisionsFor(asks: SocketAsk[], session: string | null): SocketAsk[] {
  return asks.filter(
    (a) => a.item !== undefined || (session !== null && (a.shown_in ?? [a.session]).includes(session)),
  );
}

export function autopilotState(
  status: { state: "off" | "starting" | "idle" | "working" | "error" },
  decisions: number,
): AutopilotState {
  switch (status.state) {
    case "off":
      return "off";
    case "error":
      return "error";
    case "starting":
    case "working":
      return decisions > 0 ? "needs" : "working";
    case "idle":
      return decisions > 0 ? "needs" : "idle";
  }
}
