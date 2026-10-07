// Every open pull request on a project, as a tab in the stage.
//
// The same list the right pane draws, given the width to be read at. All this
// adds is what a picked row does here, and that is the piece the rest of the
// review surface depends on.
//
// ## Why a pick tells the store which pull request it picked
//
// There is no read by number anywhere in the app. The poll knows the pull
// requests of branches this machine has units for, and nothing else can be
// looked up: a tab opened for a pull request on a branch nobody has checked out
// would render as no pull request at all.
//
// This list is exactly where that happens, because it lists every open pull
// request on the repo and most of them are on branches that are not here. So a
// pick hands the row's own `PullRequest` to `prReviewStore` before it opens
// anything (`notePr`, in `openPrTab`), which is the only thing that makes those tabs work.

import { openPrTab } from "../../../utils/openPrTab";
import type { PullRequest } from "../../../utils/forgeTypes";
import PrList from "./PrList";
import styles from "./PrListView.module.css";

export default function PrListView(props: { workspace: string }) {
  // The panel follows the pick rather than the checked-out branch, so the
  // verdict rows beside the reader are about what they just opened. Cleared by
  // its own Back, or by the branch changing.
  const pick = (pr: PullRequest) => openPrTab(props.workspace, pr);

  return (
    <div class={styles.stage}>
      <div class={styles.column}>
        <PrList root={props.workspace} onPick={pick} />
      </div>
    </div>
  );
}
