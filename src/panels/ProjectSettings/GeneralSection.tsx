import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import type { SpaceProject } from "../../utils/topicMembers";
import ProjectIconPicker, { type ProjectIconChoice } from "../../components/ProjectIconPicker/ProjectIconPicker";
import BranchesSection from "./BranchesSection";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

export const LAYOUT: Record<string, string> = {
  worktree: "Bare repo with worktrees",
  incomplete: "Bare repo, no worktrees yet",
  plain: "Git repo",
  "plain-dir": "Folder without git",
};

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/** What a project is, what it wears, and for a git project where it points.
 *  The layout is a fact read off disk, so it is shown, not edited. */
export default function GeneralSection(props: { project: SpaceProject; kind: string | undefined }) {
  const [busy, setBusy] = createSignal(false);

  // Both commands emit `config://changed`, which is what brings the new icon
  // back into `props.project`; an uploaded image goes in as its SOURCE path and
  // the backend copies it into the icon store.
  async function choose(choice: ProjectIconChoice) {
    setBusy(true);
    try {
      if (choice.file) await invoke("set_project_icon_file", { path: props.project.path, source: choice.file });
      else await invoke("set_project_icon", { path: props.project.path, icon: choice.icon ?? null });
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(): Promise<string | null> {
    try {
      return (await invoke<string | null>("pick_icon_file")) ?? null;
    } catch (e) {
      toast(String(e));
      return null;
    }
  }

  return (
    <>
      <Section heading="Project">
        <Row label="Layout" hint="Read from disk. Tori does not convert a project between layouts.">
          <span class={styles.value}>{(props.kind && LAYOUT[props.kind]) ?? "Unknown"}</span>
        </Row>
      </Section>

      <Section heading="Icon">
        <div class={styles.wide}>
          <ProjectIconPicker
            seed={props.project.path}
            name={props.project.name ?? props.project.path}
            icon={props.project.icon ?? null}
            iconFile={props.project.iconFile ?? null}
            favicon={props.project.favicon ?? null}
            busy={busy()}
            onChoose={(choice) => void choose(choice)}
            onPickFile={pickFile}
          />
        </div>
      </Section>

      <Show when={props.kind && props.kind !== "plain-dir"}>
        <BranchesSection projectPath={props.project.path} projectName={props.project.name ?? props.project.path} />
      </Show>
    </>
  );
}
