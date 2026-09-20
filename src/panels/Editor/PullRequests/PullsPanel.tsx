// The Pull requests panel: the pull request for the branch this pane has
// checked out, and every reason there is none.
//
// Scoped to **one** pull request rather than listing the repo's. The list moved
// to its own stage tab (`PrListView`), where there is room to read it; what a
// 320px column is good at is answering "where does the thing I am working on
// stand", which is one pull request, three verdicts and one merge control.
//
// ## Where each part comes from
//
// - **Which state to draw** is `pullsPanelState`, derived from `forgeChip` so
//   this and the sidebar chip cannot disagree about a branch.
// - **The pull request's detail** is `prReviewStore`, the same store the diff
//   and overview tabs read. The panel calls `ensure` and never fetches.
// - **Checks and the review verdict** come from the poll store, never fetched
//   here, which is what stops a row and its sidebar chip from being two answers
//   to one question. The price is an honest blank for a branch no tick covered,
//   the same blank the list rows show.
// - **The counts** (`1 approval, 2 change requests`) are the summary's, because
//   the poll's `reviewDecision` is a verdict and not a tally.
//
// **The merge control lives here and nowhere else.** Two buttons that merge is
// two places for a stale verdict to offer it.

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  FileStack,
  GitMerge,
  List,
  Loader,
  MessageSquare,
  RefreshCw,
  SquarePen,
  type LucideIcon,
} from "lucide-solid";
import { compactAgo } from "../../../utils/compactAge";
import {
  emitWith,
  onWith,
  ADD_BRANCH_UNIT,
  OPEN_IN_EDITOR,
  PR_OPENED,
  REMOVE_BRANCH_UNIT,
  type AddBranchUnit,
  type OpenInEditor,
  type PrOpened,
  type RemoveBranchUnit,
} from "../../../utils/events";
import { forgeChip, forgeDoor } from "../../../utils/forgeChip";
import { gitStateFor } from "../../../utils/gitActions";
import { createPrFlow } from "../../../utils/prCreateFlow";
import { stepKeys } from "../../../utils/keyNav";
import { fileRowName } from "../../../utils/prFiles";
import { originHost } from "../../../utils/prUrl";
import { mergeGate } from "../../../utils/mergeGate";
import { pullsPanelState, type DirectRead } from "../../../utils/pullsPanelState";
import { prAllTabId, prDiffTabId, prListTabId, prTabId } from "../../../utils/syntheticTabs";
import { reloadPrList } from "../../../utils/prListStore";
import { projectUnitFor } from "../../../utils/sessionActivity";
import {
  forgeHosts,
  forgePause,
  forgeRepo,
  pollNow,
  resolveForgeRepo,
  uncoveredUnits,
  unitStatus,
} from "../../../utils/forgeStatus";
import {
  ensure,
  headDrift,
  isViewed,
  notePr,
  prEntry,
  refresh,
  setViewingPr,
  viewingPr,
} from "../../../utils/prReviewStore";
import {
  forgeErrorMessage,
  type CheckRollup,
  type MergeMethod,
  type PullRequest,
} from "../../../utils/forgeTypes";
import type { Selection } from "../../LeftSidebar/LeftSidebar";
import MergeBar from "./MergeBar";
import { CreatePrFlowDialog } from "../../../components/Dialogs/CreatePrDialog";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Icon from "../../../components/Icon/Icon";
import styles from "./PullsPanel.module.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/// What the checks row says, from the rollup the poll already has.
///
/// `none` renders no row at all: a repo with no CI is not a repo with pending
/// CI, and a permanent grey line on every pull request in it says nothing.
///
/// The tone names the failing count rather than reporting that some are
/// failing, which is the difference between a row that answers and one that
/// sends the reader to github.com to find out how bad it is.
function checksLine(
  checks: CheckRollup,
): { tone: "good" | "bad" | "busy"; text: string; icon: LucideIcon } | null {
  switch (checks.state) {
    case "failure":
      return {
        tone: "bad",
        icon: CircleX,
        text: `${checks.failing} of ${plural(checks.total, "check")} failing`,
      };
    case "pending":
      return { tone: "busy", icon: Loader, text: "Checks running" };
    case "success":
      return { tone: "good", icon: CircleCheck, text: `${plural(checks.total, "check")} passed` };
    default:
      return null;
  }
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/// Below this the counts come off the row. The letter and the filename are what
/// a row is for, and they have to survive the 160px the pane resizes down to.
const COUNTS_MIN_WIDTH = 220;

export default function PullsPanel(props: {
  root: string | null;
  /** Who the "Ask agent to draft" button in the create form writes to. */
  selected: Selection | null;
}) {
  const paused = () => forgePause(props.root);
  const git = () => gitStateFor(props.root);
  const branch = () => git().branch;

  // Origin and the default base are this panel's own two reads. Neither is in
  // any store: the sidebar holds a map of origins it built for its own rows,
  // and asking it would couple a panel to a component that may not be mounted.
  const [origin, setOrigin] = createSignal<string | null | undefined>(undefined);
  const [base, setBase] = createSignal<string | null>(null);
  const [direct, setDirect] = createSignal<DirectRead>({ kind: "idle" });

  const [checksOpen, setChecksOpen] = createSignal(false);
  const [mergeBusy, setMergeBusy] = createSignal(false);
  const [mergeError, setMergeError] = createSignal<string | null>(null);
  const [merged, setMerged] = createSignal(false);

  /// Which read is current. The panel is reused across branches and projects,
  /// so a slow answer can land after the one that replaced it and put one
  /// branch's pull request under another's name.
  let current = 0;

  /// The same guard for the mutations, counted per pull request rather than per
  /// branch.
  ///
  /// Its own counter because the two move on different events. The list tab can
  /// point the panel at another pull request without the branch shifting at
  /// all, and a refusal from the merge before it would otherwise be drawn under
  /// the one now on screen. Sharing `current` would instead discard the direct
  /// read in flight for a branch that has not changed, and nothing would ask
  /// again.
  let landing = 0;

  // Accounts changing clears every resolution in the store, so ask again. Same
  // as `PrList`: the pause is derived from the repo's account, and an
  // unresolved repo reads as no pause at all.
  createEffect(() => {
    const root = props.root;
    if (root && !forgeRepo(root)) void resolveForgeRepo(root);
  });

  async function askDirectly(root: string, on: string, mine: number, refreshIt = false) {
    setDirect({ kind: "loading" });
    try {
      const pr = await invoke<PullRequest | null>("forge_pr_for_branch", {
        projectPath: root,
        branch: on,
        refresh: refreshIt,
      });
      if (mine === current) setDirect({ kind: "done", pr });
    } catch (e) {
      if (mine === current) setDirect({ kind: "error", message: forgeErrorMessage(e) });
    }
  }

  createEffect(
    on([() => props.root, branch, paused], ([root, on, why]) => {
      const mine = ++current;
      setDirect({ kind: "idle" });
      setOrigin(undefined);
      setBase(null);
      if (!root) return;
      void (async () => {
        try {
          const found = await invoke<string | null>("git_origin", { projectPath: root });
          if (mine === current) setOrigin(found);
        } catch {
          if (mine === current) setOrigin(null);
        }
        try {
          const b = await invoke<string | null>("git_default_base_branch", { projectPath: root });
          if (mine === current) setBase(b);
        } catch {
          if (mine === current) setBase(null);
        }
      })();
      // Nothing the forge could answer while it is paused, and a request the
      // frontend does not make is the half that costs nothing at all.
      if (on && why === null) void askDirectly(root, on, mine);
    }),
  );

  /// A branch change is a different question, so the pull request somebody
  /// picked in the list tab stops being the answer to it.
  ///
  /// `defer` is what makes this a *change* rather than a mount. The pick sets
  /// the override and then opens a tab, and the panel mounting beside it would
  /// otherwise clear the override on its way in, which is the one moment it is
  /// guaranteed to be wrong.
  createEffect(
    on(
      [() => props.root, branch],
      ([root]) => {
        if (root) setViewingPr(root, null);
      },
      { defer: true },
    ),
  );

  // A pull request opened from the Changes panel is one no read here has seen.
  // Rust's write-through makes the sidebar chip flip at once; this is its own
  // request, so it has to be told.
  onCleanup(
    onWith<PrOpened>(PR_OPENED, (d) => {
      const on = branch();
      if (!on || !d?.projectPath || d.projectPath !== props.root || paused() !== null) return;
      void askDirectly(d.projectPath, on, current, true);
    }),
  );

  const prFlow = createPrFlow({
    root: () => props.root,
    origin: () => origin() ?? null,
    baseBranch: base,
    ask: {
      selected: () => props.selected,
      // What the branch changed, not what the working tree holds. Nothing here
      // is committed yet on the Changes panel's side of this; here the work is
      // already in commits, and naming a clean tree's zero files would tell the
      // agent the branch changed nothing.
      paths: () => branchPaths(),
    },
    // The counter bump is the point. `submit` emits `PR_OPENED` first, and the
    // re-read that starts can come back from a forge that has not caught up
    // with its own create, landing "no pull request" over one just opened.
    onOpened: (pr) => {
      if (props.root) notePr(props.root, pr.number, pr);
      ++current;
      setDirect({ kind: "done", pr });
    },
  });

  const state = createMemo(() => {
    const root = props.root;
    const on = branch();
    const unit = root && on ? unitStatus(root, on) : null;
    const seen = root ? viewingPr(root) : null;
    return pullsPanelState({
      chip: forgeChip({
        origin: origin(),
        hosts: forgeHosts(),
        branch: on,
        paused: paused(),
        status: unit,
        offBase: git().sync?.base?.ahead,
        hasUpstream: git().sync?.upstream.has_upstream,
      }),
      status: unit,
      paused: paused(),
      door: forgeDoor({ origin: origin(), hosts: forgeHosts(), paused: paused() }),
      origin: origin(),
      branch: on,
      base: base(),
      sync: git().sync,
      direct: direct(),
      viewing: seen === null ? null : { number: seen, pr: root ? prEntry(root, seen).pr : null },
    });
  });

  /// The pull request on screen, or null. Everything below it reads from here
  /// rather than re-deriving the state, so there is one answer to "which one".
  const shown = createMemo(() => {
    const s = state();
    return s.kind === "loaded" ? s : null;
  });

  /// The other half of the same question: the state's two lines, or null when
  /// there is a pull request to draw instead. Narrowed here so the JSX below
  /// reads `headline` off something that is known to have one.
  const say = createMemo(() => {
    const s = state();
    return s.kind === "loaded" ? null : s;
  });

  /// What to press in a state that has no pull request in it.
  ///
  /// Which of the two routes the primary takes is `prPath`'s, never a second
  /// reading of the same facts here: a form this cannot submit and a compare
  /// page it sends you to instead are one decision, and the button has to be
  /// named for the one that will actually happen.
  const actions = createMemo<
    { label: string; run: () => void; primary?: boolean; busy?: boolean }[]
  >(() => {
    const s = say();
    const root = props.root;
    if (!s || !root) return [];
    // Named for where it lands. A button that says "Open a pull request" and
    // opens a browser tab on another host has told you the wrong thing about
    // what it is going to do.
    const away = {
      label: `Open compare on ${originHost(origin() ?? "") ?? "the remote"}`,
      primary: true,
      busy: true,
      run: () => void prFlow.openCompare(),
    };
    const inApp = prFlow.path() !== "compare";
    switch (s.kind) {
      case "onBase":
        return [
          {
            label: "New branch from base",
            primary: true,
            run: () =>
              emitWith<AddBranchUnit>(ADD_BRANCH_UNIT, { projectPath: root, base: s.branch }),
          },
        ];
      case "noPrUnpushed":
        return [
          inApp
            ? {
                label: "Push and open a pull request",
                primary: true,
                busy: true,
                run: () => void prFlow.openPr(),
              }
            : away,
          // Its own button, because pushing and proposing are two decisions and
          // a branch can be worth having on origin long before it is worth
          // reviewing.
          { label: "Push only", busy: true, run: () => void prFlow.pushBranch() },
        ];
      case "noPrPushed":
        return [
          inApp
            ? {
                label: "Open a pull request",
                primary: true,
                busy: true,
                run: () => void prFlow.openPr(),
              }
            : away,
        ];
      default:
        return [];
    }
  });

  /// Everything that was about the pull request on screen rather than about
  /// the branch, plus the reads for the new one.
  ///
  /// Keyed on the number, not on the branch: the list tab can point the panel
  /// at a different pull request without the branch moving at all, and a
  /// "Merged." line carried across that swap sits over one nobody merged.
  ///
  /// The store owns the three reads and is idempotent per pull request, so a
  /// panel coming back to one already open costs nothing.
  createEffect(
    on([() => props.root, () => shown()?.number], ([root, number]) => {
      ++landing;
      setChecksOpen(false);
      setMergeBusy(false);
      setMergeError(null);
      setMerged(false);
      if (root && number !== undefined) ensure(root, number);
    }),
  );

  const entry = createMemo(() => {
    const root = props.root;
    const s = shown();
    return root && s ? prEntry(root, s.number) : null;
  });
  const summary = () => entry()?.summary ?? null;
  const uncovered = () => (props.root ? uncoveredUnits(props.root) : 0);

  /// The poll's record for whichever pull request is on screen.
  ///
  /// Null for one picked in the list tab whose branch this machine has no unit
  /// for, which is the honest blank those rows already show: the poll never
  /// covered it, and nothing else knows its checks.
  const polled = createMemo(() => {
    const root = props.root;
    const s = shown();
    return root && s ? unitStatus(root, s.pr.headRef) : null;
  });

  const [paneWidth, setPaneWidth] = createSignal(Infinity);
  const wide = () => paneWidth() >= COUNTS_MIN_WIDTH;

  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (!paneRef) return;
    const ro = new ResizeObserver(([e]) => setPaneWidth(e.contentRect.width));
    ro.observe(paneRef);
    onCleanup(() => ro.disconnect());
  });

  /// `j` and `k` down and up the file list, while the focus is in the panel.
  ///
  /// Attached here rather than to the window, which is what makes a bare letter
  /// safe at all: a `j` pressed anywhere else in the app is somebody typing.
  /// The same goes for the create-PR form inside this panel, which `bareKey`
  /// holds harmless. Enter and Space are the rows' own, since each one is a
  /// button and that is what a button does with them.
  const onKeyDown = stepKeys(() => paneRef, "[data-file-row]", "j", "k");

  /// How many of this file's conversations are still open.
  ///
  /// Unresolved only: a resolved thread is still reachable in the diff, and a
  /// count that included it would mark a file as needing attention it does not.
  const unresolvedIn = (path: string) =>
    (entry()?.threads ?? []).filter((th) => th.path === path && !th.isResolved).length;

  /// `300 of 412` where the API stopped describing it, plain otherwise. Visible
  /// before any scrolling, which is the point: a short list that looks whole is
  /// the failure nobody reports.
  const filesCount = () => {
    const e = entry();
    if (!e) return "";
    const shownFiles = e.files.length;
    const total = summary()?.counts?.changedFiles ?? null;
    return e.filesTruncated && total !== null ? `${shownFiles} of ${total}` : `${shownFiles}`;
  };

  /// The pull request's own totals, which only the detail read carries. Absent
  /// until it lands rather than summed from the files in hand, since those are
  /// capped and the sum would be quietly short.
  const totals = () => summary()?.counts ?? null;

  const pending = () => entry()?.pending ?? [];

  /// How many comments are held, and how many of them cannot go out as written.
  ///
  /// Counted apart rather than folded in: a stale anchor blocks the whole
  /// submit, so "3 pending" with one of them unsendable is a number that reads
  /// as ready when it is not.
  const pendingLabel = () => {
    const held = pending().length;
    const off = pending().filter((c) => c.anchor !== "ok").length;
    return off ? `${held} pending, ${off} needs a look` : `${held} pending`;
  };

  /// Re-read all three parts, and the poll behind the checks.
  ///
  /// Named parts rather than "reload": the store's whole point is that a submit
  /// costs one threads read and not every patch. Refresh is the one caller that
  /// genuinely wants all three, and `pollNow("manual")` is what bypasses Rust's
  /// freshness window so a build that just finished shows its new rollup.
  function refreshAll(number: number) {
    const root = props.root;
    if (!root) return;
    void refresh(root, number, "files");
    void refresh(root, number, "threads");
    void refresh(root, number, "summary");
    void pollNow("manual");
  }

  /// Open one file where there is room to read it.
  ///
  /// `notePr` first, because the tab reads the store on mount and there is no
  /// read by number: a pull request the poll never covered would otherwise
  /// render as no pull request at all over a diff it was holding all along.
  function openFile(path: string) {
    const root = props.root;
    const s = shown();
    if (!root || !s) return;
    notePr(root, s.number, s.pr);
    // Transient, and the only opener that asks for it: reading a pull request
    // is walking a list of files, and a tab per row leaves a strip nobody can
    // read by the time the review is written. Double click keeps one.
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, {
      path: prDiffTabId(root, s.number, path),
      preview: true,
    });
  }

  const drifted = () => {
    const root = props.root;
    const s = shown();
    return !!root && !!s && headDrift(root, s.number);
  };

  // --- landing it -----------------------------------------------------------

  /// Run a mutation that lands or moves the branch, and report the server's own
  /// sentence when it refuses.
  ///
  /// Its wording, verbatim, is the point: GitHub knows about branch protection
  /// Tori cannot read, so "At least 1 approving review is required" is a fact
  /// only the refusal carries.
  async function land(run: () => Promise<void>, after: () => void) {
    const mine = landing;
    setMergeBusy(true);
    setMergeError(null);
    try {
      await run();
      if (mine !== landing) return;
      after();
      // The chip and the row read the server's verdict, and it has changed.
      void pollNow("manual");
    } catch (e) {
      if (mine === landing) setMergeError(forgeErrorMessage(e));
    } finally {
      if (mine === landing) setMergeBusy(false);
    }
  }

  const mergePr = (method: MergeMethod) => {
    const root = props.root;
    const s = shown();
    if (!root || !s) return;
    return land(
      () => invoke<void>("forge_merge", { projectPath: root, number: s.number, method }),
      () => {
        setMerged(true);
        // Every listing of this project is now wrong, and a listing is where
        // the user goes to confirm it worked. The store outlives the list tab,
        // so it can be told while nothing is drawing one.
        void reloadPrList(root);
      },
    );
  };

  const updateBranch = () => {
    const root = props.root;
    const s = shown();
    if (!root || !s) return;
    return land(
      () => invoke<void>("forge_update_branch", { projectPath: root, number: s.number }),
      // Re-read rather than assumed: the update is queued on the server (202),
      // so `behind` may still be the current answer for a moment, and guessing
      // `clean` here would offer a merge the server refuses.
      () => void refresh(root, s.number, "summary"),
    );
  };

  /// The branch-unit this pull request was built on, if this machine has one.
  /// What decides whether "Delete branch" is offered: a head never checked out
  /// here has nothing local to remove.
  const localUnit = createMemo(() => {
    const root = props.root;
    const s = shown();
    return root && s ? projectUnitFor(root, s.pr.headRef) : null;
  });

  /// The files this branch changed, read only when the draft button asks.
  ///
  /// `origin/<base>` rather than the local ref, for the reason the command's
  /// own doc gives. A failed read is an empty list: the request still names the
  /// branch and its base, which is more than a refusal would.
  async function branchPaths(): Promise<string[]> {
    const root = props.root;
    const to = base();
    if (!root || !to) return [];
    try {
      return await invoke<string[]>("git_branch_paths", {
        projectPath: root,
        base: `origin/${to}`,
      });
    } catch {
      return [];
    }
  }

  function askToDeleteBranch() {
    const unit = localUnit();
    const s = shown();
    if (!unit || !s) return;
    // Handed to the sidebar, which owns the guards: a dirty worktree, unpushed
    // commits, and agents still running in the folder.
    emitWith<RemoveBranchUnit>(REMOVE_BRANCH_UNIT, {
      projectPath: unit.projectPath,
      branch: s.pr.headRef,
    });
  }

  return (
    <div class={styles.panel} ref={paneRef} onKeyDown={onKeyDown}>
      <div class={styles.head}>
        <span class={styles.title}>Pull request</span>
        <span class={styles.spacer} />
        {/* Back before Refresh, because it is the one control that changes what
            the rest of the panel is about. */}
        <Show when={props.root && viewingPr(props.root) !== null}>
          <Button variant="ghost" size="xs" onClick={() => setViewingPr(props.root!, null)}>
            Back to this branch
          </Button>
        </Show>
        <Show when={shown()}>
          {(s) => (
            <>
              {/* The stacked half of the per-file tabs. Beside Refresh
                  because it is the same kind of control: about this pull
                  request, wherever in it the reader currently is. */}
              <IconButton
                size="xs"
                icon={<Icon icon={FileStack} size={14} />}
                tooltip="Review all files in one tab"
                onClick={() =>
                  props.root &&
                  emitWith<OpenInEditor>(OPEN_IN_EDITOR, {
                    path: prAllTabId(props.root, s().number),
                  })
                }
              />
              <IconButton
                size="xs"
                icon={<Icon icon={RefreshCw} size={14} />}
                tooltip="Re-read this pull request"
                onClick={() => refreshAll(s().number)}
              />
            </>
          )}
        </Show>
        {/* The list lives in the stage now, so the panel is where the route to
            it has to be: a surface with no way in is not shipped. */}
        <Show when={props.root}>
          {(root) => (
            <IconButton
              size="xs"
              icon={<Icon icon={List} size={14} />}
              tooltip="All pull requests"
              onClick={() =>
                emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: prListTabId(root()) })
              }
            />
          )}
        </Show>
      </div>

      {/* On top of whatever else is drawn. A tick that did not reach every unit
          is a partial answer, and the states below would each read as complete
          without it. */}
      <Show when={uncovered() > 0}>
        <div class={styles.notice}>
          Checks are not shown for {uncovered()} branch{uncovered() === 1 ? "" : "es"} this poll did
          not cover.
        </div>
      </Show>

      <Switch>
        <Match when={shown()}>
          {(s) => (
            <div class={styles.body}>
              {/* Block 1: which pull request this is. */}
              <div class={styles.identity}>
                <div class={styles.identityTop}>
                  <span
                    class={styles.pill}
                    data-pr-state={s().pr.isDraft ? "draft" : s().pr.state}
                  >
                    {s().pr.isDraft ? "draft" : s().pr.state}
                  </span>
                  <span class={styles.number}>#{s().pr.number}</span>
                  <span class={styles.spacer} />
                  <IconButton
                    size="xs"
                    icon={<Icon icon={ExternalLink} size={14} />}
                    tooltip={`Open pull request ${s().pr.number} on github.com`}
                    onClick={() => window.open(s().pr.url, "_blank", "noreferrer")}
                  />
                </div>
                {/* Wraps to as many lines as it needs. A truncated title is the
                    one line on this surface nobody can reconstruct. */}
                <div class={styles.subject}>{s().pr.title}</div>
                <div class={styles.meta}>{metaLine(s().pr, summary()?.updatedAt ?? null)}</div>
                <div class={styles.branches}>
                  {/* The head loses its *start* when it does not fit: a long
                      branch name is prefixed with the part every branch shares. */}
                  <span class={styles.headRef} title={s().pr.headRef}>
                    {s().pr.headRef}
                  </span>
                  <span class={styles.into} aria-hidden="true">
                    -&gt;
                  </span>
                  <span class={styles.baseRef}>{s().pr.baseRef}</span>
                </div>
              </div>

              {/* Block 2: the three verdicts, one line each. A badge grid wraps
                  into nonsense at 320px. */}
              <div class={styles.rollup}>
                <Show
                  when={polled()}
                  fallback={
                    <div class={styles.verdictRow} data-verdict="checks" data-tone="blank">
                      <Icon icon={CircleDot} size={14} aria-hidden="true" />
                      <span>No checks read for this branch.</span>
                    </div>
                  }
                >
                  {(unit) => (
                    <Show when={checksLine(unit().checks)}>
                      {(line) => (
                        <>
                          {/* A rollup the read described nothing of has
                              nothing to expand, so it is a line rather than a
                              button: a disabled control with no reason beside
                              it reads as a broken one. */}
                          <Dynamic
                            component={unit().checks.contexts.length ? "button" : "div"}
                            type={unit().checks.contexts.length ? "button" : undefined}
                            class={styles.verdictRow}
                            data-verdict="checks"
                            data-tone={line().tone}
                            aria-expanded={unit().checks.contexts.length ? checksOpen() : undefined}
                            onClick={
                              unit().checks.contexts.length
                                ? () => setChecksOpen(!checksOpen())
                                : undefined
                            }
                          >
                            <Icon icon={line().icon} size={14} aria-hidden="true" />
                            <span class={styles.verdictText}>{line().text}</span>
                            <Show when={unit().checks.contexts.length}>
                              <Icon icon={checksOpen() ? ChevronDown : ChevronRight} size={14} aria-hidden="true" />
                            </Show>
                          </Dynamic>
                          <Show when={checksOpen()}>
                            <ul class={styles.contexts}>
                              <For each={unit().checks.contexts}>
                                {(c) => (
                                  <li class={styles.context} data-check-state={c.state}>
                                    <span class={styles.contextName}>{c.name}</span>
                                    <Show when={c.url}>
                                      {(url) => (
                                        <a href={url()} target="_blank" rel="noreferrer">
                                          Details
                                        </a>
                                      )}
                                    </Show>
                                  </li>
                                )}
                              </For>
                              {/* The query caps the node list, so a long rollup
                                  lists fewer checks than it counts. */}
                              <Show when={unit().checks.contexts.length < unit().checks.total}>
                                <li class={styles.contextMore}>
                                  {unit().checks.total - unit().checks.contexts.length} more not
                                  described by this read.
                                </li>
                              </Show>
                            </ul>
                          </Show>
                        </>
                      )}
                    </Show>
                  )}
                </Show>

                {/* The counts are the summary's and the colour is the poll's,
                    the same source the chip uses. Absent rather than zeroed
                    until the summary lands: "nobody has approved" is a verdict,
                    and nobody has reached it. */}
                <div
                  class={styles.verdictRow}
                  data-verdict="reviews"
                  data-decision={polled()?.reviewDecision ?? "unread"}
                >
                  <Icon icon={MessageSquare} size={14} aria-hidden="true" />
                  <span class={styles.verdictText}>{reviewsLine(summary()?.counts?.reviews ?? null)}</span>
                </div>

                <div class={styles.verdictRow} data-verdict="merge">
                  <Icon icon={GitMerge} size={14} aria-hidden="true" />
                  <span class={styles.verdictText}>
                    {summary() ? mergeGate(summary()!.mergeableState).summary : "Checking whether this can merge…"}
                  </span>
                </div>
              </div>

              {/* Block 3: the one merge control in the app. */}
              <Show when={s().pr.state === "open"}>
                <MergeBar
                  state={summary()?.mergeableState ?? null}
                  busy={mergeBusy()}
                  error={mergeError()}
                  merged={merged()}
                  url={s().pr.url}
                  onMerge={(method) => void mergePr(method)}
                  onUpdateBranch={() => void updateBranch()}
                  onDeleteBranch={localUnit() ? askToDeleteBranch : undefined}
                />
              </Show>

              {/* The head has moved since the patches in hand were read, so
                  every anchor in every open diff tab describes a file the
                  server no longer has. */}
              <Show when={drifted()}>
                <div class={styles.drift}>
                  <span>This pull request has new commits since you read it.</span>
                  <Button
                    variant="ghost"
                    onClick={() => props.root && void refresh(props.root, s().number, "files")}
                  >
                    Reload the diff
                  </Button>
                </div>
              </Show>

              <Show when={entry()?.filesError}>
                {(message) => <div class={`${styles.notice} ${styles.bad}`}>{message()}</div>}
              </Show>

              {/* Block 4: the files, flat. At 320px a tree spends a header row
                  and an indent level per directory to save nothing, and it puts
                  headers in the way of moving through files. */}
              <div class={styles.filesHead}>
                <span class={styles.filesTitle}>Files</span>
                <span class={styles.fileCount}>{filesCount()}</span>
                <span class={styles.spacer} />
                <Show when={totals()}>
                  {(n) => (
                    <span class={styles.counts}>
                      <span class={styles.added}>+{n().additions}</span>
                      <span class={styles.removed}>-{n().deletions}</span>
                    </span>
                  )}
                </Show>
              </div>

              <Show when={entry()?.filesLoading}>
                <div class={styles.notice}>Loading files…</div>
              </Show>

              <For each={entry()?.files ?? []}>
                {(f) => (
                  <div
                    class={styles.fileRow}
                    data-file-row={f.path}
                    role="button"
                    tabIndex={0}
                    aria-label={fileRowName(f, unresolvedIn(f.path), isViewed(props.root!, s().number, f.path))}
                    onClick={() => openFile(f.path)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      openFile(f.path);
                    }}
                  >
                    {/* A letter survives a 160px panel; an icon plus a word
                        does not. The row's accessible name spells it out. */}
                    <span class={styles.status} data-file-status={f.status} aria-hidden="true">
                      {f.status.slice(0, 1).toUpperCase()}
                    </span>
                    <span
                      class={styles.path}
                      data-viewed={isViewed(props.root!, s().number, f.path) || undefined}
                    >
                      {/* The directory truncates from its *start*, so the
                          filename is never what disappears. */}
                      <Show when={fileDir(f.path)}>
                        <span class={styles.dir}>{fileDir(f.path)}/</span>
                      </Show>
                      <span class={styles.name}>{fileName(f.path)}</span>
                    </span>
                    {/* Unresolved only, and zero renders nothing rather than a
                        `0`. Resolved threads are still reachable in the diff. */}
                    <Show when={unresolvedIn(f.path)}>
                      {(n) => (
                        <span class={styles.unresolved} aria-hidden="true">
                          <Icon icon={MessageSquare} size={12} />
                          {n()}
                        </span>
                      )}
                    </Show>
                    <Show when={isViewed(props.root!, s().number, f.path)}>
                      <Icon icon={Check} size={13} class={styles.viewedMark} aria-hidden="true" />
                    </Show>
                    {/* First thing dropped when the pane gets narrow: the
                        letter and the filename are what a row is for. */}
                    <Show when={wide()}>
                      <span class={styles.counts} aria-hidden="true">
                        <span class={styles.added}>+{f.additions}</span>
                        <span class={styles.removed}>-{f.deletions}</span>
                      </span>
                    </Show>
                  </div>
                )}
              </For>

              {/* GitHub's own ceiling, not a budget of ours: past it the server
                  stops describing the pull request, so the honest thing is to
                  say so and hand over the link. */}
              <Show when={entry()?.filesTruncated}>
                <div class={styles.notice}>
                  This pull request changes more files than the API will describe.{" "}
                  <a href={`${s().pr.url}/files`} target="_blank" rel="noreferrer">
                    See all of them on github.com
                  </a>
                </div>
              </Show>

              {/* Hidden entirely at zero pending. A permanent submit bar over a
                  pull request nobody is reviewing is chrome on every diff in
                  the app. */}
              <Show when={pending().length}>
                <div class={styles.footer}>
                  <span class={styles.pendingCount} data-pending={pending().length}>
                    <Icon icon={SquarePen} size={13} aria-hidden="true" />
                    {pendingLabel()}
                  </span>
                  <span class={styles.spacer} />
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={() =>
                      props.root &&
                      emitWith<OpenInEditor>(OPEN_IN_EDITOR, {
                        path: prTabId(props.root, s().number),
                      })
                    }
                  >
                    Finish review
                  </Button>
                </div>
              </Show>
            </div>
          )}
        </Match>

        <Match when={say()}>
          {(s) => (
            <div class={styles.empty} data-panel-state={s().kind}>
              <div class={styles.headline}>{s().headline}</div>
              <Show when={s().detail}>
                <p class={styles.detail}>{s().detail}</p>
              </Show>
              {/* The remote verbatim, because which one it is is the whole
                  point of this state. */}
              <Show when={s().kind === "inert" ? origin() : null}>
                {(url) => <code class={styles.origin}>{url()}</code>}
              </Show>
              <Show when={actions().length}>
                <div class={styles.emptyActions}>
                  <For each={actions()}>
                    {(act) => (
                      <Button
                        variant={act.primary ? "primary" : "ghost"}
                        size="sm"
                        disabled={act.busy && prFlow.busy()}
                        onClick={act.run}
                      >
                        {act.label}
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Match>
      </Switch>

      <Show when={prFlow.formOpen()}>
        <CreatePrFlowDialog flow={prFlow} />
      </Show>
    </div>
  );
}

/// Who opened it and when, then how recently it moved.
///
/// Two halves because they arrive separately: the author rides the
/// `PullRequest` the poll already has, and `updatedAt` exists only on the
/// detail read. Waiting for both would leave the line blank for a fact nobody
/// needs to wait for.
function metaLine(pr: PullRequest, updatedAt: string | null): string {
  const parts = [pr.author];
  const at = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isNaN(at)) parts.push(`updated ${compactAgo(at / 1000)}`);
  return parts.join(", ");
}

/// The standing verdicts, or the fact that nobody has counted them.
///
/// Three blanks that must not read as each other: the summary has not landed,
/// the host does not describe a pull request in one read, and the reviews walk
/// was cut short. All three are "not counted", which is not "nobody approved".
function reviewsLine(counts: { approved: number; changesRequested: number } | null): string {
  if (!counts) return "Reviews not counted yet.";
  if (counts.approved === 0 && counts.changesRequested === 0) return "No reviews yet.";
  const parts: string[] = [];
  if (counts.approved) parts.push(plural(counts.approved, "approval"));
  if (counts.changesRequested) parts.push(plural(counts.changesRequested, "change request"));
  return parts.join(", ");
}
