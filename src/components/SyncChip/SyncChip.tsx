// The selected branch's standing against its upstream and its base, at the end
// of the toolbar's crumb.
//
// Every decision about *what* it says is `utils/branchSync.ts`'s; what lives
// here is the glyph weight, the tone, and the fact that it is a control. A
// branch with nothing to report renders no element at all: silence is the
// resting state, and a permanent "in sync" pill on a clean branch spends the
// reader's attention on the news that there is no news.

import { createMemo, For, Show } from "solid-js";
import Tooltip from "../Tooltip/Tooltip";
import { emitWith, SET_RIGHT_MODE, type SetRightMode } from "../../utils/events";
import { gitStateFor } from "../../utils/gitActions";
import { syncState, type SyncLevel } from "../../utils/branchSync";
import styles from "./SyncChip.module.css";

/** How many conflicted paths the tooltip names before it stops counting them
 *  out. Past a handful the list is the shape of the problem, not its detail. */
const PATHS_SHOWN = 6;

/** The control's accessible name. Separate from the label, which is glyphs and
 *  counts ("↓3"), and from the tooltip, which is the sentence behind it:
 *  a screen reader reading an arrow aloud names a character, not a state. */
const NAME: Record<Exclude<SyncLevel, "none">, string> = {
  conflicts: "Conflicts with the base branch",
  diverged: "Diverged from the upstream",
  behind: "Behind the upstream",
  baseBehind: "Behind the base branch",
  ahead: "Commits to push",
  unpushed: "Branch not pushed yet",
};

export default function SyncChip(props: { root: string | null }) {
  const state = createMemo(() => syncState(gitStateFor(props.root).sync));
  const level = () => state().level;

  return (
    <Show when={level() !== "none"}>
      <Tooltip
        as="button"
        type="button"
        class={`${styles.chip} ${styles[state().tone]}`}
        data-sync-level={level()}
        aria-label={NAME[level() as Exclude<SyncLevel, "none">]}
        label={
          <>
            <div>{state().detail}</div>
            <Show when={state().conflicts.length > 0}>
              <ul class={styles.paths}>
                <For each={state().conflicts.slice(0, PATHS_SHOWN)}>{(path) => <li>{path}</li>}</For>
                <Show when={state().conflicts.length > PATHS_SHOWN}>
                  <li>{`and ${state().conflicts.length - PATHS_SHOWN} more`}</li>
                </Show>
              </ul>
            </Show>
          </>
        }
        // The Changes panel is where every one of these states is acted on, and
        // it is the one surface that already shows the branch's own commits.
        onClick={() => emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" })}
      >
        {state().label}
      </Tooltip>
    </Show>
  );
}
