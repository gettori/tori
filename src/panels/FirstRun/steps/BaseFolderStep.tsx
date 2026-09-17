import { For, Show } from "solid-js";
import { Folder } from "lucide-solid";
import Button from "../../../components/Button/Button";
import Icon from "../../../components/Icon/Icon";
import type { FirstRunSpace } from "../../../utils/firstRun";
import { shortHome } from "../../../utils/names";
import styles from "../FirstRun.module.css";

export const BASE_FOLDER_LEAD = (
  <>
    Tori scans one folder and reads it as <code>&lt;base&gt;/&lt;space&gt;/&lt;project&gt;</code>. Pick the
    folder you already keep repos in, like ~/Projects. Not your home folder, and not a single repo.
    Nothing is moved or changed.
  </>
);

export function rootSpaces(spaces: FirstRunSpace[]): FirstRunSpace[] {
  return spaces.filter((s) => !s.external);
}

export default function BaseFolderStep(props: {
  root: string | null;
  spaces: FirstRunSpace[];
  home: string;
  busy?: boolean;
  onChoose: () => void;
}) {
  const found = () => rootSpaces(props.spaces);
  const projects = () => found().reduce((n, s) => n + s.projects.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <Show
      when={props.root}
      fallback={
        <>
          <div class={styles.row}>
            <Button variant="primary" disabled={props.busy} onClick={() => props.onChoose()}>
              Choose folder
            </Button>
            <span class={styles.hint}>Opens the macOS folder picker.</span>
          </div>
          <div class={styles.placeholder}>No folder chosen yet</div>
        </>
      }
    >
      {(root) => (
        <>
          <div class={styles.row}>
            <div class={styles.pathField}>
              <Icon icon={Folder} />
              <span class={styles.pathText}>{shortHome(root(), props.home)}</span>
            </div>
            <Button disabled={props.busy} onClick={() => props.onChoose()}>
              Change
            </Button>
          </div>
          <Show
            when={found().length > 0}
            fallback={
              <>
                <div class={styles.note}>Empty folder. Nothing to scan yet.</div>
                <div class={styles.card}>
                  That is fine. The next step creates a space inside it, which is all Tori needs to
                  open.
                </div>
              </>
            }
          >
            <div class={styles.note}>
              <span class={styles.found}>Found</span> {plural(found().length, "space")},{" "}
              {plural(projects(), "project")} · the space step is already answered
            </div>
            <div class={`${styles.card} ${styles.scan}`}>
              <span class={styles.hint}>{shortHome(root(), props.home)}</span>
              <For each={found()}>
                {(s) => (
                  <div class={styles.scanRow}>
                    <span>{s.name}</span>
                    <span>{plural(s.projects.length, "project")}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}
