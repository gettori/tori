// Every entry point goes through `openProjectSettings`, so a section request
// reaches the dialog however it opens.

import { createSignal } from "solid-js";
import { emitWith, OPEN_PROJECT_SETTINGS, type OpenProjectSettings } from "./events";
import { sameCwd } from "./pathScope";

export type ProjectSection = "general" | "worktrees" | "agents" | "tooling";

export const SECTION_LABEL: Record<ProjectSection, string> = {
  general: "General",
  worktrees: "Worktrees",
  agents: "Agents",
  tooling: "Tooling",
};

/** The sections a project of this layout has, in rail order. Worktrees is a
 *  bare container's, since `.shared/` and the setup command belong to it. */
export function sectionsFor(kind: string | undefined): ProjectSection[] {
  const worktrees = kind === "worktree" || kind === "incomplete";
  return ["general", ...(worktrees ? (["worktrees"] as const) : []), "agents", "tooling"];
}

const [shown, setShown] = createSignal<string[]>([]);

/** Mark `path` as having its settings on screen, until the returned call. */
export function markProjectShown(path: string): () => void {
  setShown((now) => [...now, path]);
  return () =>
    setShown((now) => {
      const at = now.indexOf(path);
      return at < 0 ? now : [...now.slice(0, at), ...now.slice(at + 1)];
    });
}

/** Whether this project's settings are open, so its sidebar row can say so. */
export const projectShown = (path: string) => shown().some((p) => sameCwd(p, path));

/** Open a project's settings dialog, on `section` when one is named. */
export function openProjectSettings(path: string, section?: ProjectSection): void {
  emitWith<OpenProjectSettings>(OPEN_PROJECT_SETTINGS, { path, section });
}
