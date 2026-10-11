import { For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// What `conversion_preview` answers when a project can convert.
export type ConversionPreview = {
  branch: string;
  leaf: string;
  target: string;
  tori: { from: string; to: string }[];
  nested: { from: string; to: string }[];
  outside: string[];
  topics: string[];
};

// Converting a plain clone to the bare plus worktree layout. Everything the
// move touches is listed before anything runs, and anything that would stop it
// is said in place of the button working: the preview's refusal, then whatever
// the app itself has open in the project.
export default function ConvertLayoutDialog(props: {
  projectName: string;
  projectPath: string;
  /** null while the preview loads. */
  preview: ConversionPreview | null;
  refusal: string | null;
  blockers: readonly string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const rel = (path: string) =>
    path.startsWith(`${props.projectPath}/`)
      ? `${props.projectName}/${path.slice(props.projectPath.length + 1)}`
      : path;
  const stopped = () => props.refusal ?? props.blockers[0] ?? null;
  const ready = () => !!props.preview && !stopped();

  return (
    <Dialog
      open
      title={`Convert "${props.projectName}" to worktree layout`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={props.busy || !ready()} onClick={() => props.onConfirm()}>
            {props.busy ? "Converting..." : "Convert"}
          </Button>
        </>
      }
    >
      <Show when={props.refusal}>{(reason) => <div class={styles.warning}>{reason()}</div>}</Show>
      <For each={props.refusal ? [] : props.blockers}>{(b) => <div class={styles.warning}>{b}</div>}</For>
      <Show when={!props.refusal && props.preview}>
        {(p) => (
          <>
            <div class={styles.msg}>
              Nothing in git is lost: uncommitted changes, stashes, local branches and remotes all stay.
            </div>
            <div class={styles.wtDetail}>
              <div class={styles.wtDetailRow}>
                <span class={styles.wtDetailKey}>Checkout</span>
                <span class={styles.wtDetailVal}>{rel(p().target)}</span>
              </div>
              <div class={styles.wtDetailRow}>
                <span class={styles.wtDetailKey}>Repo</span>
                <span class={styles.wtDetailVal}>.git becomes .bare</span>
              </div>
              <For each={p().tori}>
                {(m) => (
                  <div class={styles.wtDetailRow}>
                    <span class={styles.wtDetailKey}>Topic</span>
                    <span class={styles.wtDetailVal}>{`${rel(m.from)} -> ${rel(m.to)}`}</span>
                  </div>
                )}
              </For>
              <For each={p().nested}>
                {(m) => (
                  <div class={styles.wtDetailRow}>
                    <span class={styles.wtDetailKey}>Moves</span>
                    <span class={styles.wtDetailVal}>{`${rel(m.from)} -> ${rel(m.to)}`}</span>
                  </div>
                )}
              </For>
              <For each={p().outside}>
                {(path) => (
                  <div class={styles.wtDetailRow}>
                    <span class={styles.wtDetailKey}>Repaired</span>
                    <span class={styles.wtDetailVal}>{path}</span>
                  </div>
                )}
              </For>
            </div>
            <For each={p().topics}>
              {(name) => (
                <div class={styles.msg}>
                  {`Topic "${name}" reads this repo's default branch, which the new layout does not check out until you add it.`}
                </div>
              )}
            </For>
            <div class={styles.msg}>
              Earlier agent sessions stay recorded at the old path, so they drop out of this branch's history.
            </div>
          </>
        )}
      </Show>
    </Dialog>
  );
}
