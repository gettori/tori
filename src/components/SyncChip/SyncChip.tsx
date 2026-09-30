// The selected branch's standing against its upstream and its base, at the end
// of the toolbar's crumb.
//
// Every decision about *what* it says is `utils/branchSync.ts`'s; what lives
// here is the glyph weight, the tone, and the fact that it is a control. A
// branch with nothing to report renders no element at all: silence is the
// resting state, and a permanent "in sync" pill on a clean branch spends the
// reader's attention on the news that there is no news.

import { createMemo, For, Show } from "solid-js";
import { CloudOff } from "lucide-solid";
import Icon from "../Icon/Icon";
import SyncMarks from "../SyncMarks/SyncMarks";
import Tooltip from "../Tooltip/Tooltip";
import { emitWith, SET_RIGHT_MODE, type SetRightMode } from "../../utils/events";
import { gitStateFor, type LastFetch } from "../../utils/gitActions";
import { syncMarks, syncState, type SyncLevel } from "../../utils/branchSync";
import { finishedPr } from "../../utils/prRelation";
import { fetchRootNow } from "../../utils/remoteSync";
import styles from "./SyncChip.module.css";

/** How many conflicted paths the tooltip names before it stops counting them
 *  out. Past a handful the list is the shape of the problem, not its detail. */
const PATHS_SHOWN = 6;

/** The levels that get words beside the glyphs. A count needs none: the glyph
 *  says which direction and the number says how far. These three need a decision
 *  rather than a routine pull, and this is the one surface with the room to say
 *  so without a second line or a truncated name.
 *
 *  `conflicts` is absent for the opposite reason: its words trailed a run that
 *  ends in a pull count, so "1 master: 1 conflict" read as one phrase about the
 *  wrong remote. The red glyph carries the number itself, and the base's name
 *  is a hover away. */
const SAYS: Partial<Record<SyncLevel, true>> = {
  diverged: true,
  baseBehind: true,
  unpushed: true,
};

/** The control's accessible name. Separate from the glyphs, which a screen
 *  reader would otherwise read out as characters rather than as a state. */
const NAME: Record<Exclude<SyncLevel, "none">, string> = {
  conflicts: "Conflicts with the base branch",
  checks: "Pull request checks failing",
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
  const finished = () => finishedPr(props.root, gitStateFor(props.root).branch, gitStateFor(props.root).sync);
  const state = createMemo(() => syncState(gitStateFor(props.root).sync, finished()));
  const level = () => state().level;
  const lastFetch = (): LastFetch | null => gitStateFor(props.root).lastFetch;

  // A branch with nothing to say whose fetches keep failing is not in sync, it
  // is unanswered - and the counts behind the silence are as old as the last
  // fetch that worked. Quiet failures are never toasted, so without this the
  // one repo Tori cannot reach is the one it says nothing about.
  const staleFetch = () => level() === "none" && !!lastFetch()?.error;
  const shown = () => level() !== "none" || staleFetch();
  // Every fact, not just the loudest. This surface outlives the sidebar, which
  // toggles away, so a branch that is ninety-nine behind *and* about to conflict
  // has to show both: the words are the verdict, the marks are what it owes.
  const marks = createMemo(() => syncMarks(gitStateFor(props.root).sync, finished()));
  const words = () => (SAYS[level()] ? state().label : "");

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
                  <Show when={f().error}>
                    {(e) => <div class={styles.failure}>{`Last fetch failed: ${e()}`}</div>}
                  </Show>
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
        <Show when={!staleFetch()} fallback={<Icon icon={CloudOff} class={styles.glyph} />}>
          <SyncMarks marks={marks()} />
          <Show when={words()}>{words()}</Show>
        </Show>
      </Tooltip>
    </Show>
  );
}
