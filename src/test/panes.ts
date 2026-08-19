// Seeding a layout for a suite that is about more than one pane.
//
// The shell seeds a single pane per workspace (plan phase 12), so a suite whose
// subject is a split, a move between panes or a drop has to ask for the second
// pane rather than inherit it. Written straight to storage, the way a workspace
// that had been split before this run would have it, so the suite exercises the
// load path instead of a helper the app does not have.
import { seedTwoPane } from "../layout/layoutStore";

const LS_PANES = "sway.panes.v1";

/** Store the two-pane layout (`left` | `right`) for `ws`. Call after clearing
 *  localStorage and before rendering the shell. */
export function storeTwoPanes(ws: string, opts?: { rightShare?: number }) {
  localStorage.setItem(
    LS_PANES,
    JSON.stringify({
      [ws]: seedTwoPane({
        rightShare: opts?.rightShare ?? 50,
        showLeft: true,
        showRight: true,
      }),
    }),
  );
}
