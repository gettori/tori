import { For, Show, createSignal } from "solid-js";
import { FolderGit2 } from "../../components/Icon/icons";
import Icon from "../../components/Icon/Icon";
import Popover from "../../components/Popover/Popover";
import type { SubmoduleNeed, SubmoduleTouch } from "../../utils/chatTypes";
import { emitWith, SET_RIGHT_MODE, type SetRightMode } from "../../utils/events";
import styles from "./Chat.module.css";

const NEED_TEXT: Record<SubmoduleNeed, string> = {
  commit: "Uncommitted. It is its own repo: commit there and open its own PR, then commit the new pointer here.",
  push: "Committed, not pushed. Push it and open its own PR, then commit the new pointer here.",
  pointer: "Pushed. Commit the new pointer in the repo that holds it.",
  done: "Committed and pushed, and the pointer is committed.",
};

export function submoduleLabel(touches: readonly SubmoduleTouch[]): string {
  return touches.length === 1 ? `Changed submodule ${touches[0].path}` : `Changed ${touches.length} submodules`;
}

export default function SubmoduleMark(props: { touches: SubmoduleTouch[] }) {
  const [open, setOpen] = createSignal(false);
  const settled = () => props.touches.every((t) => t.need === "done");
  let anchor: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        ref={anchor}
        class={[styles.turnSubmodule, { [styles.turnSubmoduleSettled]: settled() }]}
        aria-expanded={open() ? "true" : "false"}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open())}
      >
        <Icon icon={FolderGit2} size={12} />
        {submoduleLabel(props.touches)}
      </button>
      <Show when={open()}>
        <Popover
          anchorEl={anchor}
          placement="bottom-start"
          onClose={() => setOpen(false)}
          class={styles.secretPopover}
          aria-label="Changed submodules"
        >
          <For each={props.touches}>
            {(t) => (
              <div class={styles.secretRow}>
                <span class={styles.secretPath} title={t.root}>
                  {t.path}
                </span>
                <button
                  type="button"
                  class={styles.secretShow}
                  onClick={() => {
                    setOpen(false);
                    emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" });
                  }}
                >
                  Open Changes
                </button>
                <span class={styles.submoduleNeed}>{NEED_TEXT[t.need]}</span>
              </div>
            )}
          </For>
        </Popover>
      </Show>
    </>
  );
}
