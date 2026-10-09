import { For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, Trash2 } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import IconButton from "../../../components/IconButton/IconButton";
import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import { loadErrors, onPacksChanged, refreshLoadErrors, type PackKind } from "../../../utils/packs";
import styles from "../Settings.module.css";

/** The files of one pack kind that did not load, with what to do about each. */
export default function NeedsFixing(props: { kind: PackKind }) {
  onMount(() => void refreshLoadErrors());
  onPacksChanged(props.kind, () => void refreshLoadErrors());
  const mine = () => loadErrors().filter((e) => e.kind === props.kind);
  const act = (command: "packs_remove" | "packs_update", verb: string, id: string) =>
    invoke(command, { kind: props.kind, id })
      .then(() => refreshLoadErrors())
      .catch((err) => emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} ${id}: ${String(err)}` }));

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
              <Show when={e.removable}>
                {(id) => (
                  <div class={styles.toolControls}>
                    <Show when={e.restorable}>
                      <IconButton
                        size="sm"
                        icon={<Icon icon={RotateCcw} />}
                        tooltip="Restore"
                        aria-label={`Restore ${e.file}`}
                        onClick={() => void act("packs_update", "restore", id())}
                      />
                    </Show>
                    <IconButton
                      size="sm"
                      icon={<Icon icon={Trash2} />}
                      tooltip="Delete"
                      aria-label={`Delete ${e.file}`}
                      onClick={() => void act("packs_remove", "delete", id())}
                    />
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
