import type { BranchLineItem, BranchLineMode } from "../panels/Settings/settingsStore";

export const BRANCH_LINE_MODES: { value: BranchLineMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "pr", label: "PR only" },
  { value: "full", label: "Full" },
];

export const BRANCH_LINE_ITEMS: { id: BranchLineItem; label: string }[] = [
  { id: "pr", label: "PR" },
  { id: "stack", label: "Stack" },
  { id: "watched", label: "Watched" },
  { id: "checks", label: "Checks" },
  { id: "skipped", label: "Skipped checks" },
  { id: "diff", label: "Diff size" },
  { id: "files", label: "Files" },
  { id: "spend", label: "Spend" },
  { id: "age", label: "Age" },
  { id: "comments", label: "Comments" },
];
