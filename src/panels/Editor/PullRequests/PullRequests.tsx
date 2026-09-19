// The Pull Requests panel: the project's list, and whichever one is open.
//
// Its own panel rather than another section of the 1,300-line ReviewPanel,
// which is about the working tree. These are about work already pushed, and the
// two share no state, no refresh trigger and no failure modes.
//
// The list itself is `PrList`, which the stage tab draws too. What is left here
// is the one thing that differs: picking a row opens the pull request *in this
// column*, because that is what this panel has always done.

import { createSignal, createEffect, createMemo, on, Show } from "solid-js";
import { forgePause } from "../../../utils/forgeStatus";
import type { PullRequest } from "../../../utils/forgeTypes";
import { reloadPrList } from "../../../utils/prListStore";
import PrList from "./PrList";
import PrDetail from "./PrDetail";

export default function PullRequests(props: { root: string | null }) {
  /// Which pull request is open in the detail view, and which project it was
  /// picked from.
  ///
  /// The root is held with it rather than read live. Clearing this on a project
  /// change is an effect, and effects run after the render that changed the
  /// prop: for that one frame the detail view would be handed the new project
  /// and the old pull request, and go and fetch it.
  const [opened, setOpened] = createSignal<{ root: string; pr: PullRequest } | null>(null);
  const paused = () => forgePause(props.root);

  createEffect(
    on([() => props.root, paused], () => {
      // A pull request from the project just left, or one the credential can no
      // longer fetch files for, is a view that cannot refresh itself. Dropped
      // rather than left hidden behind the memo below, or coming back to the
      // project would reopen whatever was last read in it.
      setOpened(null);
    }),
  );

  // The detail view replaces the list rather than sitting beside it: the right
  // pane is one column wide, and a list plus a diff in it would leave neither
  // enough room to read.
  const detail = createMemo(() => {
    const o = opened();
    return o && o.root === props.root ? o : null;
  });

  // Unkeyed on purpose. `detail()` builds a fresh object each recompute, so
  // `keyed` would tear down and remount the detail view (re-fetching every file)
  // whenever the memo re-ran for reasons that have nothing to do with which pull
  // request is open. Unkeyed re-renders on the *branch* changing, and PrDetail's
  // own effect handles a swap from one pull request to another.
  return (
    <Show
      when={detail()}
      fallback={
        <PrList
          root={props.root}
          onPick={(pr) => props.root && setOpened({ root: props.root, pr })}
        />
      }
    >
      {(d) => (
        <PrDetail
          root={d().root}
          pr={d().pr}
          onBack={() => setOpened(null)}
          // Landing one makes every listing of this project wrong, and a listing
          // is where the user goes to confirm it worked.
          onLanded={() => reloadPrList(d().root)}
        />
      )}
    </Show>
  );
}
