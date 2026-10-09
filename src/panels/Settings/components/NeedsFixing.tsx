import { For, Show, onMount } from "solid-js";
import { loadErrors, refreshLoadErrors, type PackKind } from "../../../utils/packs";
import styles from "../Settings.module.css";

/** The files of one pack kind that did not load, with what to do about each. */
export default function NeedsFixing(props: { kind: PackKind }) {
  onMount(() => void refreshLoadErrors());
  const mine = () => loadErrors().filter((e) => e.kind === props.kind);

  return (
    <Show when={mine().length > 0}>
      <div class={styles.dangerTitle}>Needs fixing</div>
      <div class={styles.toolGrid}>
        <For each={mine()}>
          {(e) => (
            <div class={styles.toolCard}>
              <div class={styles.toolStatus}>
                <code>{e.file}</code>
              </div>
              <div class={styles.toolStatus}>{e.message}</div>
              <Show when={e.fix}>{(fix) => <div class={styles.toolStatus}>To fix: {fix()}.</div>}</Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
