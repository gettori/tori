import type { PrChildState } from "./prChildState";

export type LaneParent = "working" | "inReview" | "reviewing" | "done";
export type LaneId = LaneParent | PrChildState;

/** Mirrors `LaneConfig` in src-tauri/src/settings.rs. */
export type LaneConfig = { enabled: boolean; lit: PrChildState[]; foldReviewing: boolean };

export const PARENTS: readonly LaneParent[] = ["working", "inReview", "reviewing", "done"];

export const PARENT_OF: Readonly<Record<PrChildState, LaneParent>> = {
  noPr: "working",
  draft: "working",
  ready: "inReview",
  commented: "inReview",
  changesRequested: "inReview",
  reReview: "inReview",
  approved: "inReview",
  reviewRequested: "reviewing",
  reviewed: "reviewing",
  merged: "done",
  closed: "done",
};

const CHILDREN = Object.keys(PARENT_OF) as PrChildState[];

export const childrenOf = (parent: LaneParent) => CHILDREN.filter((c) => PARENT_OF[c] === parent);

export const LANE_LABEL: Readonly<Record<LaneId, string>> = {
  working: "Working",
  inReview: "In review",
  reviewing: "Reviewing",
  done: "Done",
  noPr: "No PR",
  draft: "Draft",
  ready: "Ready",
  commented: "Commented",
  changesRequested: "Changes requested",
  reReview: "Re-review",
  approved: "Approved",
  reviewRequested: "Review requested",
  reviewed: "Reviewed",
  merged: "Merged",
  closed: "Closed",
};

export const DEFAULT_LANES: LaneConfig = {
  enabled: false,
  lit: ["changesRequested", "approved", "reviewRequested"],
  foldReviewing: false,
};

export const sameLanes = (a: LaneConfig, b: LaneConfig) =>
  a.enabled === b.enabled &&
  a.foldReviewing === b.foldReviewing &&
  a.lit.length === b.lit.length &&
  a.lit.every((c, i) => c === b.lit[i]);

const home = (parent: LaneParent, cfg: LaneConfig): LaneParent =>
  parent === "reviewing" && cfg.foldReviewing ? "inReview" : parent;

/** `null` is no lane: the base branch, or someone else's PR that is not yours to review. */
export function laneOf(child: PrChildState | "unlaned", cfg: LaneConfig): LaneId | null {
  if (child === "unlaned") return null;
  return cfg.lit.includes(child) ? child : home(PARENT_OF[child], cfg);
}

export function laneOrder(cfg: LaneConfig): LaneId[] {
  return PARENTS.flatMap((parent) =>
    home(parent, cfg) !== parent
      ? []
      : [...CHILDREN.filter((c) => cfg.lit.includes(c) && home(PARENT_OF[c], cfg) === parent), parent],
  );
}

export const startsParked = (lane: LaneId) => (PARENTS as readonly string[]).includes(lane) && lane !== "working";
