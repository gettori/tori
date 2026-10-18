export type Unit = {
  name: string;
  folder: string;
  branch: string | null;
  space: string;
  space_color: string | null;
};

export type GroupColor = `${chrome.tabGroups.Color}`;

export type TabState = { kind: "worktree"; unit: Unit; color: GroupColor } | { kind: "other"; title: string };

export type StateRequest = { type: "state"; tabId: number };

export const NOT_WORKTREE = "not a Tori worktree";
export const NOT_RUNNING = "Tori is not running";
export const CLOSED = "Tori closed the connection";
export const NOT_SET_UP = "not set up: Tori > Settings > Browser > Install";

export const GROUPS_KEY = "groups";

export const label = (unit: Unit) => unit.branch ?? unit.folder.split("/").pop() ?? unit.folder;
