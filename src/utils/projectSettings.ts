// Every entry point goes through `openProjectSettings`, so the tab id is
// spelled once and a section request reaches the tab however it opens.

import { createSignal } from "solid-js";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "./events";
import { syntheticId } from "./syntheticTabs";

export type ProjectSection = "general" | "worktrees" | "agents" | "checks" | "trust" | "branches" | "editor";

export const SECTION_LABEL: Record<ProjectSection, string> = {
  general: "General",
  worktrees: "Worktrees",
  agents: "Agents",
  checks: "Checks",
  trust: "Trust",
  branches: "Branches",
  editor: "Editor",
};

/** The sections a project of this layout has, in rail order. Worktrees is a
 *  bare container's, since `.shared/` and the setup command belong to it, and
 *  Branches is any git kind's. */
export function sectionsFor(kind: string | undefined): ProjectSection[] {
  const worktrees = kind === "worktree" || kind === "incomplete";
  const git = worktrees || kind === "plain";
  return [
    "general",
    ...(worktrees ? (["worktrees"] as const) : []),
    "agents",
    "checks",
    "trust",
    ...(git ? (["branches"] as const) : []),
    "editor",
  ];
}

/** The tab's id for a project. The project path is the workspace, so removing
 *  the project's folder purges the tab with everything else under it. */
export const projectSettingsId = (projectPath: string) => syntheticId("project", projectPath);

// Held rather than encoded in the id: a section in the id would make each
// section its own tab, and the tab is one per project.
const [asked, setAsked] = createSignal<{ path: string; section: ProjectSection } | null>(null);

/** The section an entry point asked for, until the tab for `path` takes it. */
export function takeAskedSection(path: string): ProjectSection | null {
  const a = asked();
  if (!a || a.path !== path) return null;
  setAsked(null);
  return a.section;
}

export { asked as askedSection };

/** Open a project's settings tab, on `section` when one is named. */
export function openProjectSettings(projectPath: string, section?: ProjectSection): void {
  setAsked(section ? { path: projectPath, section } : null);
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: projectSettingsId(projectPath) });
}
