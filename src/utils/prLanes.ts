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

export type CardHue = "accent" | "red" | "amber" | "green" | "blue" | "purple" | "teal" | "pink";

export const GROUP_HUES: readonly CardHue[] = ["blue", "green", "amber", "pink"];

export const LANE_HUE: Readonly<Record<LaneId, CardHue | null>> = {
  working: "purple",
  inReview: "blue",
  reviewing: "amber",
  done: "teal",
  noPr: null,
  draft: null,
  ready: "accent",
  commented: null,
  changesRequested: "red",
  reReview: "amber",
  approved: "green",
  reviewRequested: "amber",
  reviewed: null,
  merged: "purple",
  closed: null,
};

export const HUE_VARS: Readonly<Record<CardHue, Record<string, string>>> = {
  red: {
    "--card-head": "var(--lane-red-head)",
    "--card-body": "var(--lane-red-body)",
    "--card-icon": "var(--danger-fg)",
  },
  amber: {
    "--card-head": "var(--lane-amber-head)",
    "--card-body": "var(--lane-amber-body)",
    "--card-icon": "var(--attention-fg)",
  },
  green: {
    "--card-head": "var(--lane-green-head)",
    "--card-body": "var(--lane-green-body)",
    "--card-icon": "var(--success-fg)",
  },
  blue: {
    "--card-head": "var(--lane-blue-head)",
    "--card-body": "var(--lane-blue-body)",
    "--card-icon": "var(--scale-blue)",
  },
  purple: {
    "--card-head": "var(--lane-purple-head)",
    "--card-body": "var(--lane-purple-body)",
    "--card-icon": "var(--scale-purple)",
  },
  teal: {
    "--card-head": "var(--lane-teal-head)",
    "--card-body": "var(--lane-teal-body)",
    "--card-icon": "var(--info-fg)",
  },
  pink: {
    "--card-head": "var(--lane-pink-head)",
    "--card-body": "var(--lane-pink-body)",
    "--card-icon": "var(--scale-pink)",
  },
  accent: {
    "--card-head": "var(--lane-accent-head)",
    "--card-body": "var(--lane-accent-body)",
    "--card-icon": "var(--accent-fg)",
  },
};

export const startsParked = (lane: LaneId) => (PARENTS as readonly string[]).includes(lane) && lane !== "working";
