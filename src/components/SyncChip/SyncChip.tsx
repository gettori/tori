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
import { gitStateFor, type LastFetch } from "../../utils/gitActions";
import { syncState, type SyncLevel } from "../../utils/branchSync";
import { fetchRootNow } from "../../utils/remoteSync";
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

/** How long ago the refs were last brought up to date, in the minutes the
 *  question is actually asked in. `compactAge` bottoms out at "now" for a whole
 *  hour, which is the wrong resolution for a thing that runs every ten minutes. */
function fetchedAgo(at: number, now = Date.now() / 1000): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60);
  if (minutes < 1) return "Fetched just now";
  if (minutes < 60) return `Fetched ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Fetched ${hours}h ago` : `Fetched ${Math.floor(hours / 24)}d ago`;
}

export default function SyncChip(props: { root: string | null }) {
  const state = createMemo(() => syncState(gitStateFor(props.root).sync));
  const level = () => state().level;
  const lastFetch = (): LastFetch | null => gitStateFor(props.root).lastFetch;

  // A branch with nothing to say whose fetches keep failing is not in sync, it
  // is unanswered - and the counts behind the silence are as old as the last
  // fetch that worked. Quiet failures are never toasted, so without this the
  // one repo Tori cannot reach is the one it says nothing about.
  const staleFetch = () => level() === "none" && !!lastFetch()?.error;
  const shown = () => level() !== "none" || staleFetch();

  return (
    <Show when={shown()}>
      <Tooltip
        as="button"
        type="button"
        class={`${styles.chip} ${styles[staleFetch() ? "muted" : state().tone]}`}
        data-sync-level={staleFetch() ? "staleFetch" : level()}
        aria-label={
          staleFetch() ? "Cannot reach the remote" : NAME[level() as Exclude<SyncLevel, "none">]
        }
        label={
          <>
            <div>{staleFetch() ? "These counts are as old as the last fetch that worked." : state().detail}</div>
            <Show when={state().conflicts.length > 0}>
              <ul class={styles.paths}>
                <For each={state().conflicts.slice(0, PATHS_SHOWN)}>{(path) => <li>{path}</li>}</For>
                <Show when={state().conflicts.length > PATHS_SHOWN}>
                  <li>{`and ${state().conflicts.length - PATHS_SHOWN} more`}</li>
                </Show>
              </ul>
            </Show>
            <Show when={lastFetch()}>
              {(f) => (
                <div class={styles.fetched} data-sync-fetched>
                  {f().at > 0 ? fetchedAgo(f().at) : "Not fetched yet"}
                  {/* The only place a quiet failure is ever said out loud. A
                      repo behind a credential prompt fails every sweep, and a
                      toast per sweep would be the feature uninstalling itself. */}
                  <Show when={f().error}>{(e) => <div>{`Last fetch failed: ${e()}`}</div>}</Show>
                </div>
              )}
            </Show>
          </>
        }
        onClick={() => {
          // Pressing the thing that says you are behind is as good a moment as
          // there is to find out whether you still are.
          fetchRootNow(props.root);
          // The Changes panel is where every one of these states is acted on,
          // and it is the one surface that already shows the branch's commits.
          emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" });
        }}
      >
        {staleFetch() ? "stale" : state().label}
      </Tooltip>
    </Show>
  );
}
