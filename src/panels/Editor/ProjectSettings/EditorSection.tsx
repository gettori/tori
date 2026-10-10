import { createResource, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import Button from "../../../components/Button/Button";
import SegmentedControl from "../../../components/SegmentedControl/SegmentedControl";
import {
  EDITOR_FILE_SAVED,
  emitWith,
  onWith,
  OPEN_IN_EDITOR,
  TOAST,
  type EditorFileSaved,
  type OpenInEditor,
  type ToastEvent,
} from "../../../utils/events";
import { sameCwd } from "../../../utils/pathScope";
import { setProjectFormatOnSave, settings } from "../../Settings/settingsStore";
import styles from "./ProjectSettingsView.module.css";

type Answer = "default" | "on" | "off";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * The editor answers this project gives for itself.
 *
 * Format on save is the one editor setting held per project in your settings
 * file, and it reaches every worktree under the project. The repo's own
 * `.tori/settings.json` lives in a checkout, so it is summarised only where the
 * project is one checkout: a bare container has one per worktree.
 */
export default function EditorSection(props: { projectPath: string; kind: string | undefined }) {
  const answer = (): Answer => {
    const on = settings.editor?.[props.projectPath]?.formatOnSave;
    return on == null ? "default" : on ? "on" : "off";
  };
  const choose = (next: Answer) =>
    void setProjectFormatOnSave(props.projectPath, next === "default" ? null : next === "on").catch((e) =>
      toast(String(e)),
    );

  const oneCheckout = () => props.kind === "plain" || props.kind === "plain-dir";
  const [overlay, { refetch }] = createResource(
    () => (oneCheckout() ? props.projectPath : null),
    (root) => invoke<unknown>("get_workspace_settings", { root }).catch(() => null),
  );
  const keys = () => leafKeys(overlay());
  const overlayFile = () => `${props.projectPath}/.tori/settings.json`;
  onCleanup(
    onWith<EditorFileSaved>(EDITOR_FILE_SAVED, (saved) => {
      if (sameCwd(saved.path, overlayFile())) void refetch();
    }),
  );

  return (
    <div class={styles.form}>
      <section class={styles.block}>
        <h3 class={styles.blockHead}>Format on save</h3>
        <SegmentedControl
          class={styles.modes}
          aria-label="Format on save"
          options={[
            { value: "default", label: "Default" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          value={answer()}
          onChange={choose}
        />
        <p class={styles.note}>
          Default follows the Editor settings. On or Off is this project's own answer, in every one of its worktrees.
        </p>
      </section>

      <Show when={oneCheckout()}>
        <section class={styles.block}>
          <h3 class={styles.blockHead}>Workspace settings</h3>
          <Show
            when={keys().length}
            fallback={
              <p class={styles.note}>
                This repo has no <code class={styles.mono}>.tori/settings.json</code>, so your own settings apply here.
              </p>
            }
          >
            <p class={styles.note}>
              The repo's <code class={styles.mono}>.tori/settings.json</code> answers these for itself:
            </p>
            <ul class={styles.keys}>
              <For each={keys()}>{(k) => <li class={styles.mono}>{k}</li>}</For>
            </ul>
            <div class={styles.actions}>
              <Button onClick={() => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: overlayFile() })}>Open file</Button>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );
}
