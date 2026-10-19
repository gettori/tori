export type Unit = {
  name: string;
  folder: string;
  branch: string | null;
  space: string;
  space_color: string | null;
};

export type GroupColor = `${chrome.tabGroups.Color}`;

export type TabState = { kind: "worktree"; unit: Unit; color: GroupColor } | { kind: "other"; title: string };

export const NOT_WORKTREE = "not a Tori worktree";
export const NOT_RUNNING = "Tori is not running";
export const CLOSED = "Tori closed the connection";
export const NOT_SET_UP = "not set up: Tori > Settings > Browser > Install";

export const GROUPS_KEY = "groups";
export const SHOTS_KEY = "screenshots";

const SENTENCES: Record<string, string> = {
  [NOT_WORKTREE]: "This tab is not a Tori worktree.",
  [NOT_RUNNING]: "Tori is not running.",
  [CLOSED]: "Tori is not running.",
  [NOT_SET_UP]: "Tori is not set up for this browser yet.",
};

export const sentenceOf = (why: string) => SENTENCES[why] ?? why;

export const label = (unit: Unit) => unit.branch ?? unit.folder.split("/").pop() ?? unit.folder;
