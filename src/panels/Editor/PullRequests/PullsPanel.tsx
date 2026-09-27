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
//
// ## The column and the detail
//
// The column answers where the branch stands: which pull request, three verdict
// lines, and the files it changes. What is behind those lines is a tab in the
// section at the bottom (the checks, the review, the merge), the way the Files
// tab stacks Scripts, Outline and TODOs under its tree. A verdict row is the way
// into its own tab, so the summary and the detail are not two things to find.

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDot,
  CircleX,
  FileStack,
  FileText,
  GitMerge,
  List,
  Loader,
  MessageSquare,
  RefreshCw,
  SquarePen,
  type LucideIcon,
} from "lucide-solid";
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
import { baseName, filesUnder, folderTree, type FolderNode } from "../../../utils/pathTree";
import { prMetaParts } from "../../../utils/prMeta";
import { originHost } from "../../../utils/prUrl";
import { mergeGate } from "../../../utils/mergeGate";
import { pullsPanelState, type DirectRead } from "../../../utils/pullsPanelState";
import { prAllTabId, prDiffTabId, prListTabId, prTabId } from "../../../utils/syntheticTabs";
import { PR_TABS, prLayout, prTab, revealPrTab } from "../../../utils/prSections";
import { SECTION_MIN_H } from "../../../utils/sectionLayout";
import { reloadPrList } from "../../../utils/prListStore";
import { projectPathFor, projectUnitFor } from "../../../utils/sessionActivity";
import { prRelation } from "../../../utils/prRelation";
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
  setViewedFile,
  setViewingPr,
  viewingPr,
} from "../../../utils/prReviewStore";
import {
  forgeErrorMessage,
  type CheckRollup,
  type CheckState,
  type MergeMethod,
  type PrFile,
  type PullRequest,
} from "../../../utils/forgeTypes";
import type { Selection } from "../../LeftSidebar/LeftSidebar";
import MergeBar from "./MergeBar";
import { CreatePrFlowDialog } from "../../../components/Dialogs/CreatePrDialog";
import Button from "../../../components/Button/Button";
import IconButton from "../../../components/IconButton/IconButton";
import Tooltip from "../../../components/Tooltip/Tooltip";
import Icon from "../../../components/Icon/Icon";
import Chevron from "../../../components/Chevron/Chevron";
import Checkbox from "../../../components/Checkbox/Checkbox";
import FileIcon from "../../../seti/FileIcon";
import Resizer from "../../../components/Resizer/Resizer";
import { chromeScale } from "../../Settings/settingsStore";
import ReviewForm from "./ReviewForm";
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

  /// What the poll filed this project under, which is not the folder on screen
  /// when the pane is looking at a worktree: the poll keys a project, and a
  /// worktree checkout is one unit inside it. Reading the statuses under the
  /// folder instead is a pull request with no checks and no verdict, from a
  /// tick that covered both.
  const pollRoot = () => (props.root ? (projectPathFor(props.root) ?? props.root) : null);

  const state = createMemo(() => {
    const root = props.root;
    const polling = pollRoot();
    const on = branch();
    const unit = polling && on ? unitStatus(polling, on) : null;
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
        relation: prRelation(root, on, unit?.pullRequest, git().sync),
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
  const uncovered = () => {
    const root = pollRoot();
    return root ? uncoveredUnits(root) : 0;
  };

  /// The poll's record for whichever pull request is on screen.
  ///
  /// Null for one picked in the list tab whose branch this machine has no unit
  /// for, which is the honest blank those rows already show: the poll never
  /// covered it, and nothing else knows its checks.
  const polled = createMemo(() => {
    const root = pollRoot();
    const s = shown();
    return root && s ? unitStatus(root, s.pr.headRef) : null;
  });

  let paneRef: HTMLDivElement | undefined;
  let stackEl: HTMLDivElement | undefined;

  /// Room above the detail for the pull request itself, whatever the drag asks
  /// for: a section dragged to the full height answers "which pull request is
  /// this" with a form.
  const maxH = () => (stackEl?.clientHeight ?? 0) - 160 * chromeScale();
  const detailOpen = () => prLayout.open("detail");
  const detailHeight = () => prLayout.size("detail") * chromeScale();

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

  /// Only the groups that have something in them: an empty "0 failing checks"
  /// is a heading that says nothing happened, which is not what a reader asks.
  const checkGroups = () => {
    const list = polled()?.checks.contexts ?? [];
    return CHECK_GROUPS.map((g) => ({
      ...g,
      items: list.filter((c) => c.state === g.state),
    })).filter((g) => g.items.length > 0);
  };

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

  /// Open one of this pull request's tabs in the stage. Every route out of the
  /// panel goes through here.
  ///
  /// `notePr` first, because a tab reads the store on mount and there is no
  /// read by number: a pull request the poll never covered would otherwise
  /// render as no pull request at all over a diff it was holding all along,
  /// and the strip would label it with its number and nothing else.
  function openInStage(id: (root: string, number: number) => string, preview = false) {
    const root = props.root;
    const s = shown();
    if (!root || !s) return;
    notePr(root, s.number, s.pr);
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: id(root, s.number), preview });
  }

  /// Open one file where there is room to read it. Transient, and the only
  /// opener that asks for it: reading a pull request is walking a list of
  /// files, and a tab per row leaves a strip nobody can read by the time the
  /// review is written. Double click keeps one.
  const openFile = (path: string) =>
    openInStage((root, number) => prDiffTabId(root, number, path), true);

  const drifted = () => {
    const root = props.root;
    const s = shown();
    return !!root && !!s && headDrift(root, s.number);
  };

  // --- the file tree --------------------------------------------------------

  /// The changed files as folders. Flat was the first cut, on the theory that a
  /// 320px column has no indent level to spare; what settled it the other way
  /// is a branch under one deep directory, where the shared prefix was most of
  /// every row.
  const fileTree = createMemo(() => folderTree(entry()?.files ?? []));

  /// Everything starts open, so closing one is what gets recorded. Never swept:
  /// a directory shut by hand stays shut when its files are re-read.
  const [closedDirs, setClosedDirs] = createSignal<readonly string[]>([]);
  const dirOpen = (path: string) => !closedDirs().includes(path);
  const toggleDir = (path: string) =>
    setClosedDirs((now) => (now.includes(path) ? now.filter((d) => d !== path) : [...now, path]));

  /// One empty span per level, rather than an indent in a `style` attribute:
  /// that attribute is what axe's `avoid-inline-spacing` selects on, and jsdom
  /// throws computing the style of a row carrying one. It also keeps the hover
  /// band full width, which an indented row loses.
  const rungs = (depth: number) => Array.from({ length: depth }, (_, i) => i);

  /// Whether the whole folder has been read, some of it, or none.
  const dirViewed = (node: FolderNode<PrFile>, number: number): "all" | "some" | "none" => {
    const files = filesUnder(node);
    const read = files.filter((f) => isViewed(props.root!, number, f.path)).length;
    if (!read) return "none";
    return read === files.length ? "all" : "some";
  };

  const setDirViewed = (node: FolderNode<PrFile>, number: number, on: boolean) => {
    for (const f of filesUnder(node)) setViewedFile(props.root!, number, f.path, on);
  };

  function TreeRows(p: { node: FolderNode<PrFile>; number: number; depth: number }) {
    return (
      <>
        <For each={p.node.folders}>
          {(f) => <DirRow node={f} number={p.number} depth={p.depth} />}
        </For>
        <For each={p.node.files}>
          {(f) => <FileRow file={f} number={p.number} depth={p.depth} />}
        </For>
      </>
    );
  }

  function DirRow(p: { node: FolderNode<PrFile>; number: number; depth: number }) {
    const open = () => dirOpen(p.node.path);
    return (
      <>
        <div class={styles.dirRow}>
          <For each={rungs(p.depth)}>{() => <span class={styles.rung} aria-hidden="true" />}</For>
          {/* A mouse affordance rather than a control: the row beside it
              already opens and closes the folder, and two buttons doing one
              thing is one of them in the tab order for nothing. */}
          <span class={styles.chevronSlot} aria-hidden="true" onClick={() => toggleDir(p.node.path)}>
            <Chevron open={open()} />
          </span>
          {/* Between the chevron and the name, and outside the control beside
              it: a checkbox within something that is itself a button is two
              controls the keyboard cannot tell apart. Everything under the
              folder in one press, which is how a reader clears a directory. */}
          <Checkbox
            size="sm"
            class={styles.viewedBox}
            checked={dirViewed(p.node, p.number) === "all"}
            indeterminate={dirViewed(p.node, p.number) === "some"}
            aria-label={`Viewed, everything under ${p.node.path}`}
            onChange={(on) => setDirViewed(p.node, p.number, on)}
          />
          <div
            class={styles.rowOpen}
            role="button"
            tabIndex={0}
            aria-expanded={open()}
            onClick={() => toggleDir(p.node.path)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              toggleDir(p.node.path);
            }}
          >
            {/* Isolated for the same reason the branch name is: the box is
                right-to-left so the ellipsis lands at the front, and a folder
                whose name starts with a number would be reordered with it. */}
            <span class={styles.dirName}>
              <bdi>{p.node.name}</bdi>
            </span>
          </div>
        </div>
        <Show when={open()}>
          <TreeRows node={p.node} number={p.number} depth={p.depth + 1} />
        </Show>
      </>
    );
  }

  function FileRow(p: { file: PrFile; number: number; depth: number }) {
    const viewed = () => isViewed(props.root!, p.number, p.file.path);
    return (
      <div class={styles.fileRow}>
        <For each={rungs(p.depth)}>{() => <span class={styles.rung} aria-hidden="true" />}</For>
        {/* The slot a folder's chevron sits in, empty here, so a file's box
            lines up with the box of a folder beside it. */}
        <span class={styles.chevronSlot} aria-hidden="true" />
        {/* Marked as the review goes, which is what the reader is doing while
            they walk the list. Outside the row's own control, where it would be
            a second thing Enter could mean. */}
        <Checkbox
          size="sm"
          class={styles.viewedBox}
          checked={viewed()}
          aria-label={`Viewed, ${p.file.path}`}
          onChange={(on) => setViewedFile(props.root!, p.number, p.file.path, on)}
        />
        <div
          class={styles.rowOpen}
          data-file-row={p.file.path}
          role="button"
          tabIndex={0}
          aria-label={fileRowName(p.file, unresolvedIn(p.file.path), viewed())}
          onClick={() => openFile(p.file.path)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            openFile(p.file.path);
          }}
        >
          <FileIcon name={baseName(p.file.path)} />
          <span class={styles.name} data-viewed={viewed() || undefined}>
            {baseName(p.file.path)}
          </span>
          {/* Unresolved only, and zero renders nothing rather than a `0`.
              Resolved threads are still reachable in the diff. */}
          <Show when={unresolvedIn(p.file.path)}>
            {(n) => (
              <span class={styles.unresolved} aria-hidden="true">
                <Icon icon={MessageSquare} size={12} />
                {n()}
              </span>
            )}
          </Show>
          {/* At the end of the row, where the counts used to be: a column of
              letters down the right edge is one glance, where the same letters
              between the checkbox and the name are read one row at a time. The
              row's accessible name spells the word out. */}
          <span class={styles.status} data-file-status={p.file.status} aria-hidden="true">
            {p.file.status.slice(0, 1).toUpperCase()}
          </span>
        </div>
      </div>
    );
  }

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
              {/* Prose wants a page, not a 320px column, and the pull
                  request's own tab opens on it. */}
              <IconButton
                size="xs"
                icon={<Icon icon={FileText} size={14} />}
                tooltip="Open the description in the editor"
                onClick={() => openInStage(prTabId)}
              />
              {/* The stacked half of the per-file tabs. Beside Refresh
                  because it is the same kind of control: about this pull
                  request, wherever in it the reader currently is. */}
              <IconButton
                size="xs"
                icon={<Icon icon={FileStack} size={14} />}
                tooltip="Review all files in one tab"
                onClick={() => openInStage(prAllTabId)}
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

      <div class={styles.stack} ref={stackEl}>
        <div class={styles.scroll}>
          {/* On top of whatever else is drawn. A tick that did not reach every
              unit is a partial answer, and the states below would each read as
              complete without it. */}
          <Show when={uncovered() > 0}>
            <div class={styles.notice}>
              Checks are not shown for {uncovered()} branch{uncovered() === 1 ? "" : "es"} this poll
              did not cover.
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
                      {/* One line, with the rest of it behind the pointer. Tori's
                          own tooltip rather than the native `title`, which the
                          webview does not draw: a truncated label whose full text
                          nothing shows is a truncated label. */}
                      <Tooltip<HTMLSpanElement>
                        as="span"
                        class={styles.subject}
                        label={s().pr.title}
                      >
                        {s().pr.title}
                      </Tooltip>
                      {/* The number is the way out to github.com, rather than an
                          icon beside it saying the same thing. An anchor and not a
                          button, so the middle click and the Cmd+click that every
                          other link in the app answers work here too; its own name
                          is spelled out, since the number alone tells a screen
                          reader nothing about where it goes. */}
                      <a
                        class={styles.number}
                        href={s().pr.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open pull request ${s().pr.number} on github.com`}
                      >
                        #{s().pr.number}
                      </a>
                    </div>
                    <div class={styles.meta}>
                      {prMetaParts(s().pr, summary()?.updatedAt ?? null, totals()).join(", ")}
                    </div>
                    <div class={styles.branches}>
                      {/* The head loses its *start* when it does not fit: a long
                          branch name is prefixed with the part every branch
                          shares. The `bdi` is what keeps the name itself in the
                          order it was typed: the right-to-left box that moves
                          the ellipsis to the front also reorders a name whose
                          first run is a number, so `2427-message-thread` reads
                          as `message-thread-2427`. Isolated, the box truncates
                          from the start and the text inside it does not move. */}
                      <span class={styles.headRef} title={s().pr.headRef}>
                        <bdi>{s().pr.headRef}</bdi>
                      </span>
                      <span class={styles.into} aria-hidden="true">
                        -&gt;
                      </span>
                      <span class={styles.baseRef}>{s().pr.baseRef}</span>
                    </div>
                  </div>

                  {/* Block 2: the three verdicts, one line each. A badge grid wraps
                      into nonsense at 320px. Each line leads to the tab that
                      holds what is behind it, where there is one. */}
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
                            <button
                              type="button"
                              class={styles.verdictRow}
                              data-verdict="checks"
                              data-tone={line().tone}
                              onClick={() => revealPrTab("checks")}
                            >
                              <Icon icon={line().icon} size={14} aria-hidden="true" />
                              <span class={styles.verdictText}>{line().text}</span>
                            </button>
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

                    <button
                      type="button"
                      class={styles.verdictRow}
                      data-verdict="merge"
                      onClick={() => revealPrTab("merge")}
                    >
                      <Icon icon={GitMerge} size={14} aria-hidden="true" />
                      <span class={styles.verdictText}>
                        {summary() ? mergeGate(summary()!.mergeableState).summary : "Checking whether this can merge…"}
                      </span>
                    </button>
                  </div>

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

                  {/* Block 4: the files, as folders. `j` and `k` walk the file
                      rows only, so a shut directory is a directory the keyboard
                      skips rather than one it walks through invisibly. */}
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

                  <TreeRows node={fileTree()} number={s().number} depth={0} />

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
                      <Button variant="primary" size="xs" onClick={() => openInStage(prTabId)}>
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
        </div>

        {/* The detail, one tab at a time, the way the Files tab stacks Scripts,
            Outline and TODOs under its tree. The strip is the section's header:
            collapsed, it is all that is left of it, pinned to the bottom.

            The rows above are the summary and these are what is behind them, so
            a verdict row's click lands here rather than expanding in place. */}
        <Show when={shown()}>
          {(s) => (
            <section
              class={styles.views}
              classList={{ [styles.viewsOpen]: detailOpen() }}
              style={detailOpen() ? { flex: `0 1 ${detailHeight()}px` } : undefined}
              data-section="detail"
            >
              <Show when={detailOpen()}>
                <div class={styles.sash}>
                  <Resizer
                    axis="y"
                    side="after"
                    value={detailHeight()}
                    min={SECTION_MIN_H * chromeScale()}
                    max={Math.max(SECTION_MIN_H * chromeScale(), maxH())}
                    onInput={(h) => prLayout.setSize("detail", h / chromeScale())}
                    onCommit={prLayout.saveSizes}
                  />
                </div>
              </Show>
              <div class={styles.tabStrip}>
                {/* Scrolls rather than wraps: five labels do not fit a 320px
                    column, and a strip that becomes two rows moves the control
                    beside it every time the pane is resized. */}
                <div class={styles.tabs} role="tablist" aria-label="Pull request detail">
                  <For each={PR_TABS}>
                    {(t) => (
                      <button
                        type="button"
                        role="tab"
                        id={`pr-tab-${t.id}`}
                        class={styles.tab}
                        aria-selected={prTab() === t.id}
                        aria-controls={`pr-panel-${t.id}`}
                        onClick={() => revealPrTab(t.id)}
                      >
                        {t.label}
                      </button>
                    )}
                  </For>
                </div>
                <span class={styles.spacer} />
                <IconButton
                  size="sm"
                  icon={<Icon icon={detailOpen() ? ChevronDown : ChevronUp} />}
                  aria-expanded={detailOpen()}
                  tooltip={detailOpen() ? "Collapse" : "Expand"}
                  onClick={() => prLayout.setOpen("detail", !detailOpen())}
                />
              </div>
              <Show when={detailOpen()}>
                <div
                  id={`pr-panel-${prTab()}`}
                  role="tabpanel"
                  aria-labelledby={`pr-tab-${prTab()}`}
                  class={styles.tabPanel}
                >
                  <Switch>
                    <Match when={prTab() === "review"}>
                      <ReviewForm workspace={props.root!} number={s().number} />
                    </Match>

                    <Match when={prTab() === "checks"}>
                      <Show
                        when={polled()?.checks.contexts.length}
                        fallback={
                          <div class={styles.notice}>
                            {polled() ? "This read described no checks." : "No checks read for this branch."}
                          </div>
                        }
                      >
                        {/* Grouped by how each one came out, worst first, the
                            way the host's own page reads: what fails is what a
                            reader came for, and a run of green rows is one
                            sentence rather than twenty. */}
                        <For each={checkGroups()}>
                          {(group) => (
                            <>
                              <h3 class={styles.checkHead} data-check-state={group.state}>
                                <Icon icon={group.icon} size={13} aria-hidden="true" />
                                {group.title(group.items.length)}
                              </h3>
                              <ul class={styles.contexts}>
                                <For each={group.items}>
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
                              </ul>
                            </>
                          )}
                        </For>
                        {/* The query caps the node list, so a long rollup lists
                            fewer checks than it counts. */}
                        <Show when={polled()!.checks.contexts.length < polled()!.checks.total}>
                          <div class={styles.contextMore}>
                            {polled()!.checks.total - polled()!.checks.contexts.length} more not
                            described by this read.
                          </div>
                        </Show>
                      </Show>
                    </Match>

                    {/* The one merge control in the app, in a tab rather than in
                        the column: it is the last thing a review does, and it
                        was taking the room the review itself needs. */}
                    <Match when={prTab() === "merge"}>
                      <Show
                        when={s().pr.state === "open"}
                        fallback={<div class={styles.notice}>This pull request is {s().pr.state}.</div>}
                      >
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
                    </Match>

                  </Switch>
                </div>
              </Show>
            </section>
          )}
        </Show>
      </div>

      <Show when={prFlow.formOpen()}>
        <CreatePrFlowDialog flow={prFlow} />
      </Show>
    </div>
  );
}

/// How the checks tab stacks them: worst first, each group headed by what it is.
///
/// The host's own page reads this way, and for the reason a reader has: a
/// failure is what they opened the tab for, and twenty passing rows are one
/// sentence they never have to read twice.
const CHECK_GROUPS: {
  state: CheckState;
  icon: LucideIcon;
  title: (n: number) => string;
}[] = [
  { state: "failure", icon: CircleX, title: (n) => `${plural(n, "failing check")}` },
  { state: "pending", icon: Loader, title: (n) => `${plural(n, "check")} running` },
  { state: "success", icon: CircleCheck, title: (n) => `${plural(n, "successful check")}` },
  { state: "none", icon: CircleDot, title: (n) => `${plural(n, "check")} with no result` },
];

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
