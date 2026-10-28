import { For, Show } from "solid-js";

import type { RepoValue } from "../../utils/proposals";
import s from "../Settings/Settings.module.css";
import styles from "./ProjectSettingsDialog.module.css";

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** What the repo's accepted `.tori/project.json` files set for one field, each
 *  value beside the worktrees that run it. */
export default function RepoValues<T>(props: {
  values: RepoValue<T>[];
  overridden: boolean;
  show?: (value: T) => string;
}) {
  return (
    <Show when={!props.overridden && props.values.length}>
      <ul class={styles.repoValues} data-repo-values>
        <For each={props.values}>
          {(v) => (
            <li class={styles.repoValue}>
              <span class={s.originBadge}>repo</span>
              <code class={styles.repoText}>{props.show ? props.show(v.value) : String(v.value)}</code>
              <span class={styles.repoWhere}>in {v.worktrees.map(nameOf).join(", ")}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
