import { createResource, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import Button from "../../components/Button/Button";
import {
  EDITOR_FILE_SAVED,
  emitWith,
  onWith,
  OPEN_IN_EDITOR,
  type EditorFileSaved,
  type OpenInEditor,
} from "../../utils/events";
import { sameCwd } from "../../utils/pathScope";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * What the repo's own `.tori/settings.json` answers for itself. Shown only for
 * a project that is one checkout: a bare container has one file per worktree.
 */
export default function EditorSection(props: { projectPath: string }) {
  const [overlay, { refetch }] = createResource(
    () => props.projectPath,
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
    <Section heading="Workspace settings">
      <Show
        when={keys().length}
        fallback={
          <Row
            label={
              <>
                No <code class={styles.mono}>.tori/settings.json</code>
              </>
            }
            hint="This project uses your own settings unchanged."
          />
        }
      >
        <Row
          label={
            <>
              This project has its own <code class={styles.mono}>.tori/settings.json</code>
            </>
          }
          hint={`Overrides ${keys().length} ${keys().length === 1 ? "setting" : "settings"}`}
        >
          <Button onClick={() => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: overlayFile() })}>Open file</Button>
        </Row>
        <div class={styles.chips}>
          <For each={keys()}>{(k) => <span class={styles.chip}>{k}</span>}</For>
        </div>
      </Show>
    </Section>
  );
}
