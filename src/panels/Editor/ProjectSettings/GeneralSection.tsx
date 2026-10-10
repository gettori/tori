import { createSignal, createUniqueId } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import type { SpaceProject } from "../../../utils/topicMembers";
import ProjectIconPicker, { type ProjectIconChoice } from "../../../components/ProjectIconPicker/ProjectIconPicker";
import styles from "./ProjectSettingsView.module.css";

const LAYOUT: Record<string, string> = {
  worktree: "Bare repo with worktrees",
  incomplete: "Bare repo with no worktrees yet",
  plain: "Git repo",
  "plain-dir": "Folder without git",
};

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/** What a project is and what it wears. Name, path and layout are facts read
 *  off disk, so they are shown, not edited; the icon is the one choice here. */
export default function GeneralSection(props: { project: SpaceProject; space: string; kind: string | undefined }) {
  const [busy, setBusy] = createSignal(false);
  const iconHead = createUniqueId();

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
    <div class={styles.form}>
      <dl class={styles.facts}>
        <dt>Name</dt>
        <dd>{props.project.name ?? props.project.path.split("/").pop()}</dd>
        <dt>Space</dt>
        <dd>{props.space}</dd>
        <dt>Path</dt>
        <dd class={styles.mono}>{props.project.path}</dd>
        <dt>Layout</dt>
        <dd>{(props.kind && LAYOUT[props.kind]) ?? "Unknown"}</dd>
      </dl>

      <section class={styles.block} aria-labelledby={iconHead}>
        <h3 id={iconHead} class={styles.blockHead}>
          Icon
        </h3>
        <ProjectIconPicker
          seed={props.project.path}
          icon={props.project.icon ?? null}
          iconFile={props.project.iconFile ?? null}
          favicon={props.project.favicon ?? null}
          busy={busy()}
          onChoose={(choice) => void choose(choice)}
          onPickFile={pickFile}
        />
      </section>
    </div>
  );
}
