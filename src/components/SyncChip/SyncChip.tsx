// The selected branch's standing against its upstream and its base, at the end
// of the toolbar's crumb, and the menu of what you can do about it from here.
//
// Every decision about *what* it says is `utils/branchSync.ts`'s, and about
// what it offers `utils/syncActions.ts`'s; what lives here is the glyph weight,
// the tone, and the fact that it is a control. A branch with nothing to report
// renders no element at all: silence is the resting state, and a permanent
// "in sync" pill on a clean branch spends the reader's attention on the news
// that there is no news.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { CloudOff } from "lucide-solid";
import Icon from "../Icon/Icon";
import SyncMarks from "../SyncMarks/SyncMarks";
import Tooltip from "../Tooltip/Tooltip";
import Dropdown from "../Menu/Dropdown";
import { DescribedRow, MenuRow, MenuSeparator } from "../Menu/rows";
import {
  emit,
  emitWith,
  GIT_ABORT,
  GIT_CONTINUE,
  GIT_FETCH,
  GIT_MERGE_BASE,
  GIT_PULL,
  GIT_PULL_REBASE,
  GIT_PUSH,
  GIT_RESET_UPSTREAM,
  GIT_SKIP,
  GIT_SYNC_REBASE,
  SET_RIGHT_MODE,
  type SetRightMode,
} from "../../utils/events";
import { busyIn, conflictedFiles, gitStateFor, type GitBusy, type LastFetch } from "../../utils/gitActions";
import { syncMarks, syncState, type SyncLevel } from "../../utils/branchSync";
import { syncActions, type SyncActionId } from "../../utils/syncActions";
import { OP_WORD, type ConflictOp } from "../../utils/conflict";
import { finishedPr } from "../../utils/prRelation";
import { fetchRootNow } from "../../utils/remoteSync";
import styles from "./SyncChip.module.css";

/** The palette's own events, so a row here and the command of the same name
 *  run through one handler with one guard and one confirm. */
const EVENT: Record<SyncActionId, string> = {
  continue: GIT_CONTINUE,
  skip: GIT_SKIP,
  abort: GIT_ABORT,
  reset: GIT_RESET_UPSTREAM,
  syncRebase: GIT_SYNC_REBASE,
  pull: GIT_PULL,
  pullRebase: GIT_PULL_REBASE,
  push: GIT_PUSH,
  mergeBase: GIT_MERGE_BASE,
  fetch: GIT_FETCH,
};

/** What each row waits on, so a second press while the first runs is refused
 *  by the row rather than dropped silently by the action. */
const WAITS_ON: Partial<Record<SyncActionId, readonly GitBusy[]>> = {
  reset: ["reset"],
  syncRebase: ["pull", "push"],
  pull: ["pull"],
  pullRebase: ["pull"],
  push: ["push"],
  mergeBase: ["merge"],
  fetch: ["fetch"],
};

const BUSY_WORD: Record<GitBusy, string> = {
  push: "pushing",
  pull: "pulling",
  fetch: "fetching",
  reset: "resetting",
  merge: "merging",
};

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
  const [open, setOpen] = createSignal(false);

  // A stopped rebase detaches HEAD, which `syncState` reads as nothing to say,
  // so the operation is asked about on its own. Only when one can be stopped:
  // a rebase leaves HEAD detached and the others leave conflicted files, and
  // asking on every switch is an IPC call the perf budget counts.
  const [op, setOp] = createSignal<ConflictOp>("none");
  const mayBeStopped = createMemo(() => {
    const st = gitStateFor(props.root);
    if (!props.root || !(st.sync?.detached || conflictedFiles(props.root).length > 0)) return null;
    return `${props.root}\u0000${st.head ?? ""}\u0000${conflictedFiles(props.root).length}`;
  });
  createEffect(
    on(mayBeStopped, async (key) => {
      const root = props.root;
      const now =
        key && root
          ? await invoke<ConflictOp>("git_conflict_op", { projectPath: root }).catch(() => "none" as const)
          : "none";
      if (root === props.root) setOp(now in OP_WORD ? now : "none");
    }),
  );
  const stopped = () => op() !== "none";
  const busy = () => busyIn(props.root);

  // A branch with nothing to say whose fetches keep failing is not in sync, it
  // is unanswered - and the counts behind the silence are as old as the last
  // fetch that worked. Quiet failures are never toasted, so without this the
  // one repo Tori cannot reach is the one it says nothing about.
  const staleFetch = () => !stopped() && level() === "none" && !!lastFetch()?.error;
  const shown = () => level() !== "none" || staleFetch() || stopped() || !!busy();
  // Every fact, not just the loudest. This surface outlives the sidebar, which
  // toggles away, so a branch that is ninety-nine behind *and* about to conflict
  // has to show both: the words are the verdict, the marks are what it owes.
  const marks = createMemo(() => (stopped() ? [] : syncMarks(gitStateFor(props.root).sync, finished())));
  // A never-pushed branch with commits is labelled by its count, which the push
  // mark already shows, so the words would repeat it.
  const words = () => {
    const running = busy();
    if (running) return BUSY_WORD[running];
    if (stopped()) return `${OP_WORD[op()].toLowerCase()} in progress`;
    if (!SAYS[level()]) return "";
    if (level() === "unpushed" && marks().some((m) => m.kind === "push" && m.count != null)) return "";
    return state().label;
  };
  const tone = () => (stopped() ? "warn" : staleFetch() ? "muted" : state().tone);
  const detail = () => {
    if (stopped()) {
      const n = conflictedFiles(props.root).length;
      return n
        ? `${OP_WORD[op()]} stopped on ${n} conflicted file${n === 1 ? "" : "s"}.`
        : `${OP_WORD[op()]} in progress.`;
    }
    return staleFetch() ? "These counts are as old as the last fetch that worked." : state().detail;
  };
  const name = () => {
    if (stopped()) return `${OP_WORD[op()]} in progress`;
    if (staleFetch()) return "Cannot reach the remote";
    return level() === "none" ? "Branch sync" : NAME[level() as Exclude<SyncLevel, "none">];
  };

  const actions = createMemo(() =>
    syncActions({
      sync: gitStateFor(props.root).sync,
      finished: finished(),
      upstream: gitStateFor(props.root).aheadBehind?.upstream,
      op: op(),
      conflicted: conflictedFiles(props.root).length,
    }),
  );
  const waiting = (id: SyncActionId) => (WAITS_ON[id] ?? []).some((kind) => busyIn(props.root, kind));
  const run = (id: SyncActionId) => {
    // Rows that say why they refuse stay reachable, and do nothing.
    if (actions().find((a) => a.id === id)?.refusing) return;
    emit(EVENT[id]);
  };

  const menu = () => (
    <>
      <For each={actions()}>
        {(a) => (
          <DescribedRow
            label={a.label}
            note={a.note}
            disabled={waiting(a.id)}
            refusing={a.refusing}
            onClick={() => run(a.id)}
          />
        )}
      </For>
      <MenuSeparator />
      {/* Every state is acted on in full there, and it is the one surface that
          already shows the branch's commits. */}
      <MenuRow onClick={() => emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" })}>Open Changes</MenuRow>
    </>
  );

  return (
    <Show when={shown()}>
      <Dropdown
        as="span"
        wrapper
        menu={menu()}
        placement="bottom-start"
        open={open()}
        onOpenChange={(next) => {
          // Opening the thing that says you are behind is as good a moment as
          // there is to find out whether you still are. Quiet and floored, so
          // the rows only move when the remote did.
          if (next) fetchRootNow(props.root);
          setOpen(next);
        }}
      >
        <Tooltip
          as="button"
          type="button"
          class={`${styles.chip} ${styles[tone()]}`}
          data-sync-level={stopped() ? "stopped" : staleFetch() ? "staleFetch" : level()}
          aria-label={name()}
          label={
            <>
              <div>{detail()}</div>
              <Show when={!stopped() && state().conflicts.length > 0}>
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
        >
          <Show when={!staleFetch()} fallback={<Icon icon={CloudOff} class={styles.glyph} />}>
            <SyncMarks marks={marks()} />
            <Show when={words()}>{words()}</Show>
          </Show>
        </Tooltip>
      </Dropdown>
    </Show>
  );
}
