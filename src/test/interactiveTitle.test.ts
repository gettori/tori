// The guard for the `title=` sweep (gettori/tori issue 102), and for the `tooltip`
// prop that replaces it.
//
// ## Why this flags everything rather than looking for buttons
//
// A native `title` is a mouse-only tooltip: it never appears for a keyboard
// user, it is not exposed as a description by every screen reader, and it
// cannot be styled. On an interactive control that is an accessibility defect,
// and `Tooltip` (via `Button`/`IconButton`/`Tab`'s `tooltip` prop) is the
// replacement. On a truncated label in a dense list it is fine, and a tooltip
// per row would be waste.
//
// The obvious guard - "fail when `title=` appears on a button-ish tag" - is the
// one that must not be written. It passes vacuously the moment somebody adds a
// component that forwards `title` to a button, because the new component's name
// is not in its list and nothing says so. That mistake was already made once
// while measuring this ticket: a first pass classified by tag and missed
// `Tab`'s 3 sites, because `Tab` extends `ButtonHTMLAttributes` and forwards
// `title` to the DOM without the word "button" appearing at the call site.
//
// So this guard classifies nothing. It counts every `title=` in `src/` and
// requires each file holding one to be named below with a reason and an exact
// count. A new `title=` anywhere - on a tag this file has never heard of, in a
// file that did not exist - changes a count or misses an entry, and fails. That
// is the same shape as `scripts/check-tokens.mjs`: exemptions are named, and
// each one states why.
//
// ## What is left, and the rule that keeps it
//
// The sweep is finished: `Button`, `IconButton`, `Tab` and `Tooltip` reject the
// native `title` at the type level now, so no interactive control in Tori can
// take one without going around them. What survives is listed in `KEPT`, and it
// is three kinds of thing:
//
//   * **A pinned count on a raw `span`, `div` or `li`** - the full text behind a
//     truncated label, on an element no keyboard can reach. A tooltip per row of
//     a dense list is the waste this ticket declined to add, and a `title` on
//     something unfocusable takes nothing away from a keyboard user because
//     there was never a keyboard path to it. `RAW_ELEMENT_TITLES` pins that
//     number and the test below breaks it down by tag.
//   * **Component `title` *props*** - a `Dialog`'s heading, a Settings
//     `Group`'s section header, `ChatView`'s session name. Not hover text at
//     all; they render as visible text.
//   * **Test fixtures** - a `[title="…"]` selector, or a component's `title`
//     prop passed in a test.
//
// The sharp edge inside the first group is `ROW_ONCLICK`: ten `div`s that carry
// an `onClick` and no keyboard path. They are counted here rather than swept,
// because a keyboard-openable tooltip on something the keyboard cannot select
// is a half-measure; making them real controls is its own ticket, and the count
// below is what stops that list growing quietly.
//
// **This counts prose, too.** A `title=` inside a comment is counted like any
// other, which is why `Tooltip.tsx`'s own doc comment describes the attribute
// rather than writing it. That is deliberate: teaching the scan to skip
// comments means deciding what a comment is inside JSX text, and a blind spot
// bought that way is worth less than the occasional reworded sentence.
//
// ## Scope: `.tsx` only
//
// `title=` is JSX attribute syntax, and this repo's `.ts` files carry no JSX -
// `vitest.config.ts` splits the projects on exactly that line, so a `.ts` file
// has no JSX transform available to it. Scanning `.tsx` alone also keeps this
// file out of its own scan, which otherwise reports its own regex literal as a
// violation (see the vault's gotcha on a source-scanning test reading itself).
import { describe, expect, it } from "vite-plus/test";

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, source]) => [path.replace(/^\.\.\//, ""), source]),
);

/** A file whose `title=` are legitimate, and why. */
interface Kept {
  count: number;
  reason: string;
}

// Reasons shared by a family of files. A named constant rather than the same
// sentence copied forty times: when the rule changes, it changes once, and two
// files claiming the same exemption visibly claim the *same* one.
const HEADING = "the `title` *prop* of a dialog-shaped component - the heading it renders, never hover text";
const GROUP_HEADING = "the `title` prop of a Settings `Group` - a section heading, rendered as visible text";
const TRUNCATION =
  "non-interactive `title` on a raw element: the full text behind a truncated label, on an element no keyboard can reach. issue 102 keeps these deliberately - a tooltip per row of a dense list is the waste the ticket declines to add";
const FIXTURE = "a test fixture passing a component's `title` prop, or an attribute selector asserting on one";
const ROW_ONCLICK =
  "a row-level `div` with an `onClick` and no keyboard path, so its `title` shows the full text of a line no Tab reaches. Making these real controls is its own ticket; sweeping them onto `Tooltip` here would only put keyboard-openable hover text on something the keyboard still cannot select";

const KEPT = new Map<string, Kept>([
  ["App.tsx", { count: 1, reason: `${HEADING} - the quit confirmation` }],
  ["components/Dialog/Dialog.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Dialogs/AddAccountDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/RenameAccountDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/AddBranchDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/AskpassDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/BranchRemoveDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ChangeOriginDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ConfirmDeleteTopic.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ConfirmDeleteSpace.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ConfirmDialog.test.tsx", { count: 2, reason: FIXTURE }],
  ["components/Dialogs/ConfirmDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/CreatePrDialog.test.tsx", { count: 1, reason: FIXTURE }],
  [
    "components/Dialogs/CreatePrDialog.tsx",
    {
      count: 2,
      reason: `one ${HEADING}, and one handing this dialog its own \`title\` prop from \`createPrFlow\` - the pull request's title, which is a form field's value and never hover text`,
    },
  ],
  ["components/Dialogs/DebugTargetDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/TopicWorktreeSweepDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/InitGitDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/NewTopicDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/NewProjectDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PickerModal.test.tsx", { count: 2, reason: FIXTURE }],
  ["components/Dialogs/ServerMessageDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PickerModal.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PromptModal.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Dialogs/SpaceDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PromptModal.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/WorktreeRemoveDialog.tsx", { count: 2, reason: `${HEADING}, plus one ${TRUNCATION}` }],
  ["components/Dialogs/stackedDialogs.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/ForgeChip/ForgeChip.tsx", { count: 3, reason: TRUNCATION }],
  ["components/Menu/ContextMenu.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Menu/Dropdown.test.tsx", { count: 1, reason: FIXTURE }],
  [
    "components/Omnibox/Omnibox.tsx",
    {
      count: 1,
      reason: `${HEADING}, and hidden at that: the palette's visible heading names the *mode* it is in, so its accessible name is carried by \`titleHidden\` instead`,
    },
  ],
  ["components/ShortcutSheet/ShortcutSheet.tsx", { count: 1, reason: HEADING }],
  ["components/Tooltip/Tooltip.stories.tsx", { count: 1, reason: FIXTURE }],
  ["components/Tooltip/Tooltip.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/Chat/agentTurnCeiling.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/followEdits.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/ChatView.tsx", { count: 1, reason: HEADING }],
  ["panels/Chat/MessageList.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/Chat/MessageList.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Chat/openedChat.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/restoredAcpChat.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/confirmedPick.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/openingOptions.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/pagedHistory.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/queueSteer.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/quotaSurfaces.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/resumeAtReset.chat.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/resumedPick.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/Chat/SessionDiffView.tsx", { count: 5, reason: TRUNCATION }],
  [
    "panels/Autopilot/Cockpit.tsx",
    { count: 1, reason: "the title *prop* of ChatView, the session name it shows; not hover text" },
  ],
  ["panels/Chat/SessionStats.tsx", { count: 6, reason: TRUNCATION }],
  ["panels/Chat/UsageReadout.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/CallsPanel.tsx", { count: 1, reason: ROW_ONCLICK }],
  ["panels/Editor/CommitDetail.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/DiffView.tsx", { count: 2, reason: `one ${TRUNCATION}, one ${HEADING}` }],
  ["panels/Editor/GraphView.tsx", { count: 2, reason: TRUNCATION }],
  ["panels/Editor/FileHistory.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/FileTree/FileTree.tsx", { count: 1, reason: TRUNCATION }],
  [
    "panels/Editor/FilesPanel/FilesPanel.tsx",
    {
      count: 1,
      reason: "the `title` prop of a `PanelSection`: the section heading it renders as visible text, never hover text",
    },
  ],
  ["panels/Editor/OutlinePanel.tsx", { count: 1, reason: ROW_ONCLICK }],
  ["panels/Editor/PullRequests/PrList.tsx", { count: 2, reason: TRUNCATION }],
  ["panels/Editor/PullRequests/PullsPanel.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/CheckpointTimeline.tsx", { count: 1, reason: `one ${HEADING}` }],
  [
    "panels/Editor/Editor.tsx",
    {
      count: 4,
      reason: `one ${TRUNCATION}, and three of ${HEADING}. Was two truncations until the tab registry deduplicated the strip's touched-dot span into the shared fileDots helper (written once, rendered in both the tab and its overflow row). Its 9 swept controls rest on this static check alone: the pane is 2000 lines behind a CodeMirror mount and phase 3 did not budget a mounting test for it, the same limit DebugPanel records above`,
    },
  ],
  ["panels/ProjectSettings/ProjectHeader.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/ProjectSettings/WorktreesSection.tsx", { count: 1, reason: HEADING }],
  ["panels/Editor/ProblemsPanel.tsx", { count: 2, reason: `one ${TRUNCATION}, and one ${ROW_ONCLICK}` }],
  ["panels/Editor/TodoPanel.tsx", { count: 2, reason: `one ${TRUNCATION}, and one ${ROW_ONCLICK}` }],
  ["panels/Editor/ConflictView.tsx", { count: 2, reason: `${TRUNCATION}, plus one ${HEADING}` }],
  [
    "panels/Editor/DebugPanel.tsx",
    {
      count: 1,
      reason: `${TRUNCATION}. Its 14 swept controls rest on this static check alone: the panel has no mounted test and authoring one means Tauri DAP fixtures, which phase 2 deliberately did not budget for. ReviewPanel, SearchPanel and ConflictView each got an axe run because each already had a test to hang it on`,
    },
  ],
  [
    "panels/Editor/ReviewPanel.tsx",
    { count: 5, reason: `one ${TRUNCATION}, two of ${ROW_ONCLICK}, and two of ${HEADING}` },
  ],
  ["panels/Editor/SessionPanel.tsx", { count: 3, reason: `two ${TRUNCATION}, and one ${ROW_ONCLICK}` }],
  ["panels/FirstRun/FirstRun.tsx", { count: 1, reason: `${HEADING} - the setup window's` }],
  ["panels/FirstRun/FirstRun.stories.tsx", { count: 1, reason: FIXTURE }],
  ["panels/FirstRun/intro/Intro.tsx", { count: 1, reason: `${HEADING} - the intro's` }],
  ["panels/FirstRun/job/InlineJob.stories.tsx", { count: 4, reason: FIXTURE }],
  ["panels/LeftSidebar/TopicItem.tsx", { count: 4, reason: TRUNCATION }],
  ["panels/LeftSidebar/TopicList.tsx", { count: 2, reason: HEADING }],
  ["panels/LeftSidebar/branchTruncation.test.tsx", { count: 3, reason: FIXTURE }],
  ["panels/LeftSidebar/forgeChipRow.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/LeftSidebar/needsYou.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/LeftSidebar/rollupAttribution.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/LeftSidebar/sidebarStructure.test.tsx", { count: 4, reason: FIXTURE }],
  [
    "panels/Settings/panes/AdvancedPane/AdvancedPane.tsx",
    {
      count: 4,
      reason:
        "three Settings `Group` section headings plus the `ConfirmDialog` heading the base-folder actions ask through, all rendered as visible text and none of them hover text",
    },
  ],
  ["panels/Settings/panes/AgentsPane/AgentAccounts.tsx", { count: 1, reason: HEADING }],
  [
    "panels/Settings/panes/AgentsPane/AgentPlugins.tsx",
    {
      count: 1,
      reason: `${TRUNCATION}. This one is a plugin's install path, on the row's \`li\``,
    },
  ],
  [
    "panels/Settings/panes/AgentsPane/AgentDetail.tsx",
    {
      count: 4,
      reason: `three ${TRUNCATION}, and the explanation on a struck-through capability chip, which matches the one on the chips beside it`,
    },
  ],
  [
    "panels/Settings/panes/AgentsPane/AgentFiles.tsx",
    {
      count: 2,
      reason: `one ${HEADING}, and one ${TRUNCATION}. That one is a link's full target, behind the two path segments its chip shows`,
    },
  ],
  ["panels/Settings/components/paneKit.tsx", { count: 2, reason: TRUNCATION }],
  ["panels/Settings/panes/AppearancePane/AppearancePane.tsx", { count: 2, reason: GROUP_HEADING }],
  ["panels/Settings/panes/AutopilotPane/AutopilotPane.tsx", { count: 2, reason: GROUP_HEADING }],
  ["panels/Settings/panes/ChatPane/ChatPane.tsx", { count: 4, reason: GROUP_HEADING }],
  ["panels/Settings/panes/EditorPane/EditorPane.tsx", { count: 2, reason: GROUP_HEADING }],
  ["panels/Settings/panes/PanesPane/PanesPane.tsx", { count: 1, reason: GROUP_HEADING }],
  ["panels/Settings/panes/ProjectsPane/ProjectsPane.tsx", { count: 1, reason: GROUP_HEADING }],
  ["panels/Settings/panes/IntegrationsPane/IntegrationsPane.tsx", { count: 3, reason: GROUP_HEADING }],
  ["panels/Settings/panes/RemotePane/RemotePane.tsx", { count: 1, reason: GROUP_HEADING }],
  [
    "panels/Settings/panes/ProjectsPane/TrustedProjects.tsx",
    { count: 2, reason: `one ${HEADING}, and one ${TRUNCATION}: a trusted project's path, on a \`code\`` },
  ],
  ["components/Autopilot/DecisionCard.tsx", { count: 1, reason: TRUNCATION }],
  ["components/Dialogs/RebaseDialog.tsx", { count: 2, reason: `${HEADING}, plus one ${TRUNCATION}` }],
  [
    "panels/Editor/FilesPanel/ScriptsSection.tsx",
    { count: 1, reason: "the word behind a script row's play glyph while it runs, on a span no keyboard reaches" },
  ],
  ["panels/LeftSidebar/TopicItem.test.tsx", { count: 3, reason: FIXTURE }],
  [
    "utils/sanitizeHtml.test.tsx",
    { count: 2, reason: "attack strings fed to the sanitizer, whose payload hides inside a title attribute" },
  ],
  ["panels/Settings/panes/LanguagesPane/toolActions.tsx", { count: 1, reason: HEADING }],
  [
    "panels/Settings/panes/IntegrationsPane/ForgeSection.tsx",
    { count: 1, reason: `${HEADING} - the one a host's destructive actions ask through` },
  ],
  ["panels/Terminal/TabMark.tsx", { count: 1, reason: TRUNCATION }],
  [
    "panels/LeftSidebar/LeftSidebar.tsx",
    {
      count: 4,
      // Down one: the branch row's current-checkout dot gave its title up when
      // the status glyphs moved into one shared run, which describes itself
      // through `Tooltip` rather than the native attribute.
      reason: `four of ${HEADING}`,
    },
  ],
  [
    "panels/LeftSidebar/StatusBubble.tsx",
    {
      count: 6,
      reason: `${TRUNCATION} - the rollup badge's five state chips name their state, and on a space tile, where only the winning state is drawn, the badge itself names all of them. Extracted from LeftSidebar.tsx, which held these five before the component existed`,
    },
  ],
  [
    "panels/LeftSidebar/SidebarRows.tsx",
    {
      count: 3,
      reason: `one ${ROW_ONCLICK} - a fan-out group's header, whose goal is longer than the column - plus ${TRUNCATION} on its attempt-count badge and on a branch row's icon slot, which now carries the one state its glyph draws and its label does not (a stub's dashed folder). All three came from LeftSidebar.tsx`,
    },
  ],
  [
    "panels/Terminal/HistoryPanel.tsx",
    {
      count: 2,
      reason: `one ${TRUNCATION} and one ${ROW_ONCLICK}`,
    },
  ],
  [
    "panels/Terminal/HistoryRow.tsx",
    {
      count: 1,
      reason: `a row onClick that reads as a prop of ContextMenu, which passes it through. Moved out of HistoryPanel.tsx with the row`,
    },
  ],
  [
    "panels/Terminal/Terminal.tsx",
    {
      count: 3,
      reason: `one ${TRUNCATION}, plus the title *props* of ChatView (the session name it shows) and of the Cmd+W ConfirmDialog (its heading) - neither is hover text`,
    },
  ],
]);

/** The `title=` this ticket set out to keep: the full text behind a truncated
 *  label, on a `span`, `div` or `code` that no keyboard can reach.
 *
 *  **This scan cannot see through a passthrough wrapper, and one row is now
 *  behind one.** #103 moved HistoryPanel's row from a raw `<div title=… onClick=…>`
 *  to `<ContextMenu title=… onClick=…>`, which spreads what it does not consume
 *  straight onto its trigger - so the attribute is still native at runtime and
 *  this file stopped counting it. A wrapper is therefore the quiet way out of
 *  this guard, which is worth knowing before the next one is written.
 *
 *  **Net one up on the redesign**, and not in the direction this guard wants:
 *  the agent detail page explains each capability chip with hover text on a
 *  `span` nothing can focus. It is the established chip pattern rather than a
 *  new idea, so it is pinned here rather than blocked, and the `code` entry
 *  went with the card layout that carried it.
 *
 *  **One back down** with the composer bar's standing note about a remembered
 *  model list, which is gone and took its title with it.
 *
 *  **Up one** for a prompt's attachment chip: the token `[Image 1]` is what the
 *  sentence says, and the path it stands for has nowhere else to go.
 *
 *  **Down one** with the dev build's chip. The topbar carried a "dev" tag beside
 *  the orange stripe, saying the same thing twice; the stripe stayed and the
 *  chip went, and its `title` with it.
 *
 *  **Up one** with the Worktree settings page, whose bar carries the
 *  path, truncated from the left.
 *
 *  **Up two**: the graph page's two rows, the diff tab's path and an agent
 *  file's link target, less the Changes panel's member header span and the
 *  Search view's file header div, both dropped by their rebuilds.
 *
 *  **Up one**, and the first `li`: a plugin row in Settings > Agents shows the
 *  plugin's name, and its install path is the line the row has no width for.
 *
 *  **Down one**: the pull request detail view is gone. Its branch line moved
 *  into the Pull requests panel, which still truncates the head ref, and the
 *  file list it also drew now names its rows through `aria-label`.
 *
 *  **Down four**: the checkpoint timeline became a list with a detail view.
 *  Its rows are buttons that describe themselves through `Tooltip`, and a
 *  file's name and folder each get a line of their own.
 *
 *  **Up one** with the project settings tab, whose header carries the project's
 *  path, truncated from the left, beside the Worktrees section's own. */
const RAW_ELEMENT_TITLES = 72;
/** Of those, the ones on a `div` that also carries an `onClick`. Its own ticket
 *  (see the header); pinned here so the list cannot grow quietly. The Changes
 *  panel's stash row is one: a click expands it to its files. */
const ROW_ONCLICK_ROWS = 9;

const TITLE = /\btitle=/g;

function countTitles(source: string): number {
  return (source.match(TITLE) ?? []).length;
}

/** Every file that holds at least one `title=`, with how many. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const [path, source] of Object.entries(SOURCES)) {
    const count = countTitles(source);
    if (count > 0) found.set(path, count);
  }
  return found;
}

describe("the title= guard", () => {
  it("scans the whole of src, so a passing run means something", () => {
    // The floor is far below the real count: this catches a glob that broke,
    // not a folder that grew. A guard whose scan quietly matches nothing is the
    // failure mode this whole file is arranged against.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(SOURCES)).toContain("App.tsx");
    expect(scan().size).toBeGreaterThan(50);
  });

  it("names every file holding a title=", () => {
    const unlisted = [...scan().keys()].filter((path) => !KEPT.has(path));

    // The whole point of failing open: an unknown file, or a known file that
    // grew a `title=` under a component this guard has never heard of, lands
    // here rather than slipping past a tag check.
    expect(unlisted).toEqual([]);
  });

  it("holds each entry to its exact count", () => {
    const found = scan();
    const drifted: string[] = [];
    for (const [path, entry] of KEPT) {
      const actual = found.get(path) ?? 0;
      if (actual !== entry.count) {
        drifted.push(`${path}: listed ${entry.count}, found ${actual}`);
      }
    }

    // Exact, not "at most": a file that gained a `title=` fails here even
    // though it is already exempt, and one that lost its last `title=` fails
    // until its entry goes, so neither list can rot into a blanket pardon.
    expect(drifted).toEqual([]);
  });

  it("carries no entry for a file that no longer has one", () => {
    const found = scan();
    const stale = [...KEPT.keys()].filter((path) => !found.has(path));

    expect(stale).toEqual([]);
  });

  it("states a reason for every kept file", () => {
    const unexplained = [...KEPT].filter(([, entry]) => entry.reason.length < 20);

    // "It was easier" is not a reason, and an empty string is not one either.
    expect(unexplained.map(([path]) => path)).toEqual([]);
  });

  it("keeps exactly the set the ticket set out to keep", () => {
    const byTag = new Map<string, number>();
    for (const [, source] of Object.entries(SOURCES)) {
      const regions = tagRegions(source);
      const found = /\btitle=/g;
      let match: RegExpExecArray | null;
      while ((match = found.exec(source))) {
        const region = regionAt(regions, match.index);
        // A lowercase tag is a raw DOM element; a capitalised one is a
        // component taking a `title` *prop*, and no region at all is a
        // `[title="…"]` selector in a test.
        if (!region || !/^[a-z]/.test(region[2])) continue;
        byTag.set(region[2], (byTag.get(region[2]) ?? 0) + 1);
      }
    }

    // The number issue 102 measured at the start and deliberately did not
    // touch, now that everything else is gone. Written as the breakdown rather
    // than the total, so a `span` that turned into a `button` fails here even
    // if some other file lost one and the sum still came out right.
    // The lone `code` is gone and `span` is up two: the agent cards' capability
    // list became chips on a detail page, so the same explanations moved onto a
    // different element and two more joined them. The breakdown is what makes
    // that visible rather than a silent wash against some other file's loss.
    // Down one span since: Editor's touched-dot title now has one source site
    // (the shared fileDots helper) where the strip and its overflow row each
    // had a copy.
    // Down one more: the composer bar's standing note about a remembered model
    // list is gone, and its title with it.
    // Up one div and three spans: the sidebar's Topic row (#153) shows the
    // branch behind a truncated name, and each member chip, its state badge
    // and the +N overflow carry the full text a 22px chip cannot.
    // Up one more span: the Changes panel's member headers (#157) each show
    // their branch behind a truncated label, the same way the top bar's own
    // branch name already did when there was only one of it.
    // Down one span: the sidebar's member chip is a `MemberChip` now (#158), so
    // its title rides a component prop rather than a raw element. The attribute
    // still renders; it is just no longer this census's to count.
    // Up one span: a prompt's attachment token, whose chip is the width of
    // `[Image 1]` and whose path is the thing a reader may want.
    // Down one span: the dev build's chip is gone. It sat in the topbar beside
    // the orange dev stripe repeating what the stripe already says, and one
    // marker per fact is enough.
    // Up three spans, down one div: the graph rows, the diff tab's path and an
    // agent file's link target, less the Changes panel's member header; the div
    // is the Search view's file header, which its rebuild dropped.
    // Up one span: a branch row's name, which now carries the branch's whole
    // story behind it (last commit, what it is behind, the paths a catch-up
    // would fight over) rather than only the text a narrow column truncates.
    // Down two spans: a branch row's name and a Topic's roll-up pill both gave
    // theirs up when the status glyphs moved into one shared run, and that run
    // describes itself through `Tooltip` rather than the native attribute.
    // Up one, on a tag this census had never seen: a plugin row in Settings >
    // Agents is an `li`, and its install path sits behind the plugin's name.
    // Down two divs and two spans: the checkpoint timeline's file row, its
    // backstop row and its two markers, all of which its rebuild dropped.
    // Up four spans, down one div, and three tags new to this census: a
    // decision card's ticket, a rebase row's subject and a script row's running
    // mark are spans, a trusted project's path is a `code`, and the `p` and
    // `img` are attack strings in the sanitizer's test, not elements.
    expect(Object.fromEntries([...byTag].sort())).toEqual({
      code: 1,
      div: 12,
      img: 1,
      li: 1,
      p: 1,
      // Down one span: the pull request detail view went, and the branch line
      // it truncated is drawn once now, in the panel that replaced it. Up one
      // for the project settings tab's path.
      span: 56,
    });
    expect([...byTag.values()].reduce((a, b) => a + b, 0)).toBe(RAW_ELEMENT_TITLES);
  });

  it("fails if an interactive title= comes back", () => {
    // The type rejects `title` on `Button`, `IconButton`, `Tab` and `Tooltip`,
    // so the only route back is a raw element. These are the tags that are
    // focusable and clickable without anyone adding a thing.
    const interactive = new Set(["a", "button", "input", "label", "select", "textarea"]);
    const found: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      const regions = tagRegions(source);
      const re = /\btitle=/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) {
        const region = regionAt(regions, match.index);
        if (region && interactive.has(region[2])) found.push(`${path}: <${region[2]} title=…>`);
      }
    }

    expect(found).toEqual([]);
  });

  it("holds the clickable rows to a number so the list cannot grow quietly", () => {
    const rows: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      for (const region of tagRegions(source)) {
        const attrs = source.slice(region[0], region[1]);
        if (/^[a-z]/.test(region[2]) && /\btitle=/.test(attrs) && /\bonClick=/.test(attrs)) {
          rows.push(`${path} <${region[2]}>`);
        }
      }
    }

    // A `div` with an `onClick` and no keyboard path. Out of scope here (see
    // the header), but counted, because "we left these alone" stops being true
    // the moment the number moves and nobody notices.
    expect(rows.length).toBe(ROW_ONCLICK_ROWS);
  });
});

// ---------------------------------------------------------------------------
// The other half: a swept control must not lose its accessible name.
//
// `Tooltip` describes its trigger (`aria-describedby`), and a description is
// never a name. 101 of the sites this ticket sweeps have no `aria-label` at
// all - their `title` *was* the name - so the conversion is exactly where a
// name goes missing, silently, on a control that still looks right.
//
// `Button` and `IconButton` close that by backfilling `aria-label` from
// `tooltip`, which is why a `tooltip` on one of them always resolves. What this
// checks is the case the backfill cannot reach: `tooltip` written on anything
// that does not implement it. On a raw `<button>` it is not a prop at all - it
// renders as a literal `tooltip="..."` attribute, showing nothing, naming
// nothing, and looking for all the world like the migration was done.
// ---------------------------------------------------------------------------

/** Components that accept `tooltip` and give the control a name from it. */
const BACKFILLS_NAME = new Set(["Button", "IconButton"]);
/** Components that accept `tooltip` but are named by their own visible text. */
const NAMED_BY_TEXT = new Set(["Tab"]);
/** Components that accept `tooltip` and take a *required* name prop of their
 *  own, so the tooltip is a description on a control that is already named and
 *  no backfill is wanted. `Picker`'s `ariaLabel` is required by its type, which
 *  is why there is nothing further to assert here. `Toast.CloseButton` is
 *  Kobalte's, which always carries an `aria-label` (its own translation when
 *  the caller passes none) and forwards the rest to `as={Button}`, so the
 *  tooltip reaches an implementation the `as=` hides from this scan.
 *  `PickerButton` is the same pill for a control whose choices are a dialog
 *  rather than a menu, and takes the same required `ariaLabel`. `PillToggle` is
 *  the two-state one, and has no visible text at all, so its required
 *  `ariaLabel` is the only name it will ever have. */
const NAMES_ITSELF = new Set(["Picker", "PickerButton", "PillToggle", "Toast.CloseButton"]);
/** Components that accept `tooltip` and are named by a `label` or an
 *  `aria-label` the type does not force, so the naming is checked below rather
 *  than trusted. `Toggle` is in here as well as `Switch` because the two files
 *  that pass this prop also have Solid's control-flow `Switch` in scope and
 *  alias the component around it; the scan reads the written tag name. */
const NAMED_BY_OWN_LABEL = new Set(["Switch", "Toggle"]);

/** The attribute region of every JSX opening tag: `[start, end, tagName]`.
 *
 *  Scanning backwards from an attribute to the nearest `<` does not work here,
 *  and the failure is quiet: `<IconButton icon={<Icon icon={X} />} title="…">`
 *  finds the *inner* `<Icon`, so every icon button in the app reads as a tag
 *  called `Icon`. Forward-scanning each tag to the `>` that closes it - past
 *  braces and strings - is what gets `IconButton`. */
function tagRegions(source: string): [number, number, string][] {
  const regions: [number, number, string][] = [];
  const opening = /<([A-Za-z][\w.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let comment: "line" | "block" | null = null;
    for (; i < source.length; i++) {
      const c = source[i];
      // Comments first, and this is not a nicety: a `//` note between two
      // attributes is ordinary in this codebase, and one apostrophe in it
      // ("a tab's text") reads as a string that never closes, so the tag's
      // region runs to the end of the file and every check downstream reads
      // the wrong attributes. Quietly, which is the failure mode this whole
      // file is arranged against.
      if (comment === "line") {
        if (c === "\n") comment = null;
        continue;
      }
      if (comment === "block") {
        if (c === "/" && source[i - 1] === "*") comment = null;
        continue;
      }
      if (quote) {
        if (c === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === "/" && source[i + 1] === "/") comment = "line";
      else if (c === "/" && source[i + 1] === "*") comment = "block";
      else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    regions.push([match.index + match[0].length, i, match[1]]);
  }
  return regions;
}

/** The innermost tag whose attributes contain `offset`.
 *
 *  Innermost, not first: a tag's region runs to the `>` that closes it, and an
 *  attribute holding JSX (`renderTab={(t) => <Tab …/>}`) keeps the outer tag's
 *  region open across the whole of the inner one. Reading attributes off the
 *  first match therefore reads the *parent's* attributes, which is how a
 *  `<Tab aria-label=…>` nested in an `<OverflowTabBar>` came out looking like
 *  the tab bar's own. */
function regionAt(regions: [number, number, string][], offset: number): [number, number, string] | null {
  let best: [number, number, string] | null = null;
  for (const region of regions) {
    if (offset >= region[0] && offset < region[1] && (!best || region[0] > best[0])) {
      best = region;
    }
  }
  return best;
}

interface TooltipSite {
  path: string;
  tag: string | null;
  hasAriaLabel: boolean;
  /** A `label` prop, which is a visible caption on the components that take one
   *  and is a name the same way `aria-label` is. */
  hasLabel: boolean;
  /** `<Tab … />` rather than `<Tab …>text</Tab>`: no children, so no visible text. */
  selfClosing: boolean;
}

function tooltipSites(): TooltipSite[] {
  const sites: TooltipSite[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    const regions = tagRegions(source);
    const prop = /\btooltip=/g;
    let match: RegExpExecArray | null;
    while ((match = prop.exec(source))) {
      const region = regionAt(regions, match.index);
      const attrs = region ? source.slice(region[0], region[1]) : "";
      // A polymorphic host renders *as* another component and hands it every
      // prop it did not claim, so the component that implements `tooltip` is
      // the `as` target rather than the tag it is written on. That is how
      // `<ToggleGroup.Item as={IconButton} tooltip=…>` reaches a real tooltip:
      // Kobalte's item owns the toggle behaviour and IconButton owns the name
      // and the trigger. Resolving it here keeps the check strict rather than
      // widening it - an `as` naming something that does not implement the prop
      // still fails, and so does a tooltip on a raw element.
      const polymorphic = /\bas=\{([A-Za-z][\w.]*)\}/.exec(attrs);
      sites.push({
        path,
        tag: polymorphic ? polymorphic[1] : region ? region[2] : null,
        hasAriaLabel: /\baria-label=/.test(attrs),
        hasLabel: /\blabel=/.test(attrs),
        selfClosing: attrs.trimEnd().endsWith("/"),
      });
    }
  }
  return sites;
}

describe("every tooltip= site resolves a name", () => {
  it("scans for tooltip sites at all", () => {
    // Phase 1 ships the stories and the tests that use it; the sweep adds the
    // rest. If this ever hits zero the check below is passing vacuously.
    expect(tooltipSites().length).toBeGreaterThan(0);
  });

  it("is only written on a control that implements it", () => {
    const orphaned = tooltipSites()
      .filter(
        (site) =>
          site.tag != null &&
          !BACKFILLS_NAME.has(site.tag) &&
          !NAMED_BY_TEXT.has(site.tag) &&
          !NAMES_ITSELF.has(site.tag) &&
          !NAMED_BY_OWN_LABEL.has(site.tag),
      )
      .map((site) => `${site.path}: <${site.tag} tooltip=…>`);

    // A `tooltip` on a raw element or on a component that never declared the
    // prop is inert: it names nothing and shows nothing. Use `<Tooltip>` with
    // `label`, which is what the primitive is for.
    expect(orphaned).toEqual([]);
  });

  // A tooltip is a description and never a name, and these components backfill
  // nothing from it, so a switch whose only text is its tooltip announces as
  // nothing at all.
  it("makes a switch carrying a tooltip name itself as well", () => {
    const nameless = tooltipSites()
      .filter((site) => site.tag != null && NAMED_BY_OWN_LABEL.has(site.tag))
      .filter((site) => !site.hasAriaLabel && !site.hasLabel)
      .map((site) => `${site.path}: <${site.tag} tooltip=…>`);

    expect(nameless).toEqual([]);
  });

  it("names a Tab by its own text rather than by the tooltip", () => {
    const mislabelled = tooltipSites()
      .filter((site) => site.tag != null && NAMED_BY_TEXT.has(site.tag))
      // A self-closing tab has no children, so it has no visible text for a
      // label to replace - the right panel's mode tabs are an icon and nothing
      // else, and `aria-label` is the only name they can have. A tab *with*
      // text is the case this guards.
      .filter((site) => site.hasAriaLabel && !site.selfClosing)
      .map((site) => `${site.path}: <${site.tag} tooltip=… aria-label=…>`);

    // An `aria-label` on a tab *replaces* its visible text as the accessible
    // name rather than adding to it, so a tab labelled with its full path stops
    // answering to the name every `getByRole("tab", { name })` in the suite
    // uses. See the vault gotcha of that name.
    expect(mislabelled).toEqual([]);
  });
});
