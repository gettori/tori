export type AutopilotState = "off" | "idle" | "working" | "needs" | "error";

export type AutopilotView = "autopilot" | "workspace";

/** The cockpit's banner: where the ship stands, in a line and a sentence. */
export type CockpitHero = {
  eyebrow: string;
  title: string;
  body: string;
  stats: { label: string; value: string }[];
};

export type DecisionKind = "pr" | "review" | "merge" | "question";

export const AUTOPILOT_STATES: AutopilotState[] = ["off", "idle", "working", "needs", "error"];

/** A badge past nine reads as "a lot", not as a number to act on. */
export function badgeCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** A worker's session as its dot shows it. */
export type WorkerStatus = "working" | "running" | "idle" | "needs";

/** An issue key or a pull request number, as `#` shows it. */
export type Ref = number | string;

export type ThreadMessage = { from: "me" | "autopilot" | "system"; text: string };

export type Decision = {
  /** The ask it answers. */
  id?: string;
  kind: DecisionKind;
  refNumber?: Ref;
  refKind?: "issue" | "pr";
  title: string;
  summary: string;
  age: string;
  worker?: string;
  suggestion?: string;
};

/** One item the autopilot is running, as a compact row. */
export type InFlightRow = { refNumber: Ref; branch: string; status: WorkerStatus; doing: string };

/** One item the autopilot is running, as a card with its recent log. */
export type WorkerCard = {
  refNumber: Ref;
  title: string;
  /** What to build, how it ships and what is out of scope. */
  contract?: string;
  branch: string;
  /** Line counts, e.g. "+73 -11". */
  diff: string;
  status: WorkerStatus;
  log: string[];
  /** What it is doing, in words, e.g. "Running tests". */
  doing: string;
  /** 0 to 1 while it runs; absent once it waits on the user. */
  progress?: number;
};

export type QueuedItem = { refNumber: Ref; title: string; after?: Ref };

export type ActivityItem = { time: string; text: string; needsYou?: boolean };

export type AutopilotError = { title: string; detail: string };

export type DecisionAction = "approve" | "edit" | "reply" | "dismiss";
