import type { NavTarget } from "../../utils/events";

export type AutopilotState = "off" | "idle" | "working" | "needs" | "error";

export type AutopilotView = "autopilot" | "workspace";

/** The cockpit's banner: where the ship stands, in a line and a sentence. */
export type CockpitHero = {
  eyebrow: string;
  title: string;
  body: string;
};

export type DecisionKind = "pr" | "review" | "merge" | "question";

export const AUTOPILOT_STATES: AutopilotState[] = ["off", "idle", "working", "needs", "error"];

/** A badge past nine reads as "a lot", not as a number to act on. */
export function badgeCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** A worker's session as its dot shows it. */
export type WorkerStatus = "working" | "running" | "idle" | "needs";

/** A ticket as a person reads it, `#212 (personal -> tori -> y-test)`: the
 *  label opens `url` on the forge, the place opens Tori at `target`. */
export type TicketRef = { label: string; url?: string; place: string[]; target?: NavTarget };

/** Where a ticket's number and place send a click. */
export type TicketHandlers = {
  onOpenLink?: (url: string) => void;
  onNavigate?: (target: NavTarget) => void;
};

export type ThreadMessage = { from: "me" | "autopilot" | "system"; text: string };

export type Decision = {
  /** The ask it answers. */
  id?: string;
  kind: DecisionKind;
  ticket?: TicketRef;
  refKind?: "issue" | "pr";
  /** The item's pull request, once it has one. */
  pr?: { label: string; url: string };
  title: string;
  summary: string;
  age: string;
  worker?: string;
  suggestion?: string;
};

/** One item the autopilot is running, as a compact row. */
export type InFlightRow = { ticket: TicketRef; status: WorkerStatus; doing: string };

/** One item the autopilot is running, as a card with its recent log. */
export type WorkerCard = {
  ticket: TicketRef;
  title: string;
  /** What to build, how it ships and what is out of scope. */
  contract?: string;
  /** Line counts, e.g. "+73 -11". */
  diff: string;
  status: WorkerStatus;
  log: string[];
  /** What it is doing, in words, e.g. "Running tests". */
  doing: string;
  /** 0 to 1 while it runs; absent once it waits on the user. */
  progress?: number;
};

/** `proposed` waits for your go in the chat, so it runs after nothing. */
export type QueuedItem = { ticket: TicketRef; title: string; after?: TicketRef; proposed?: boolean };

/** `text` follows the ticket when there is one. */
export type ActivityItem = { time: string; ticket?: TicketRef; text: string; needsYou?: boolean };

export type AutopilotError = { title: string; detail: string };

export type DecisionAction = "approve" | "edit" | "reply" | "dismiss";
