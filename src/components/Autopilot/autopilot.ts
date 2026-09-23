export type AutopilotState = "off" | "idle" | "working" | "needs" | "error";

export type AutopilotView = "autopilot" | "workspace";

export type DecisionKind = "pr" | "review" | "merge" | "question";

export const AUTOPILOT_STATES: AutopilotState[] = ["off", "idle", "working", "needs", "error"];

/** A badge past nine reads as "a lot", not as a number to act on. */
export function badgeCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}
