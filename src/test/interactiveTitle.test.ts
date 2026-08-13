// The guard for the `title=` sweep (skarif2/sway issue 102), and for the `tooltip`
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
// ## Two lists, and what each one means
//
//   * `PENDING_SWEEP` - files that still hold interactive `title=` call sites.
//     Each names the phase of issue 102 that converts it. This list is the work left,
//     and it is meant to reach empty; the last phase asserts that it has.
//   * `KEPT` - files whose `title=` are legitimate and stay. Component `title`
//     *props* (a dialog's heading, a settings `Group`'s heading) are not hover
//     text at all, and non-interactive `title` on a `span` or `div` is the
//     truncation affordance this ticket deliberately leaves alone.
//
// ## Scope: `.tsx` only
//
// `title=` is JSX attribute syntax, and this repo's `.ts` files carry no JSX -
// `vitest.config.ts` splits the projects on exactly that line, so a `.ts` file
// has no JSX transform available to it. Scanning `.tsx` alone also keeps this
// file out of its own scan, which otherwise reports its own regex literal as a
// violation (see the vault's gotcha on a source-scanning test reading itself).
import { describe, expect, it } from "vitest";

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, source]) => [path.replace(/^\.\.\//, ""), source]),
);

/** A file still holding interactive `title=`, and the phase that converts it. */
interface Pending {
  count: number;
  phase: 2 | 3 | 4 | 5;
}

/** A file whose `title=` are legitimate, and why. */
interface Kept {
  count: number;
  reason: string;
}

// Reasons shared by a family of files. A named constant rather than the same
// sentence copied forty times: when the rule changes, it changes once, and two
// files claiming the same exemption visibly claim the *same* one.
const HEADING =
  "the `title` *prop* of a dialog-shaped component - the heading it renders, never hover text";
const GROUP_HEADING =
  "the `title` prop of a Settings `Group`/`Picker` - a section heading";
const TRUNCATION =
  "non-interactive `title` on a span/div: the full text behind a truncated label, on an element no keyboard can reach. issue 102 keeps these deliberately - a tooltip per row of a dense list is the waste the ticket declines to add";
const FIXTURE =
  "a test fixture passing a component's `title` prop, or an attribute selector asserting on one";
const CONTROL_PASSTHROUGH =
  "the control's own native `title` pass-through, kept working while the app is swept onto `tooltip` and retired in phase 5 with the last call site";

const PENDING_SWEEP = new Map<string, Pending>([
  ["App.tsx", { count: 1, phase: 5 }],
  ["components/Dialogs/CreatePrDialog.tsx", { count: 2, phase: 5 }],
  ["components/Dialogs/ProjectIconDialog.tsx", { count: 2, phase: 5 }],
  ["components/Dialogs/SpaceDialog.tsx", { count: 5, phase: 5 }],
  ["components/LayoutToggles/LayoutToggles.tsx", { count: 3, phase: 5 }],
  ["components/OverflowTabBar.tsx", { count: 1, phase: 5 }],
  ["components/Toasts/Toasts.tsx", { count: 1, phase: 5 }],
  ["components/Toolbar/Toolbar.tsx", { count: 2, phase: 5 }],
  ["components/UpdatePill/UpdatePill.tsx", { count: 2, phase: 5 }],
  ["dev/Styleguide.tsx", { count: 2, phase: 5 }],
  ["panels/Chat/ChatView.tsx", { count: 4, phase: 4 }],
  ["panels/Chat/Composer.tsx", { count: 4, phase: 4 }],
  ["panels/Chat/MessageList.tsx", { count: 1, phase: 4 }],
  ["panels/Chat/Picker.tsx", { count: 1, phase: 4 }],
  ["panels/Chat/RuleList.tsx", { count: 2, phase: 4 }],
  ["panels/Chat/SessionDiffView.tsx", { count: 6, phase: 4 }],
  ["panels/Chat/StatusStrip.tsx", { count: 2, phase: 4 }],
  ["panels/Chat/ToolCallCard.tsx", { count: 3, phase: 4 }],
  ["panels/Editor/BookmarksPanel.tsx", { count: 3, phase: 3 }],
  ["panels/Editor/CheckpointTimeline.tsx", { count: 9, phase: 3 }],
  ["panels/Editor/CommitDetail.tsx", { count: 3, phase: 3 }],
  ["panels/Editor/CommitLog.tsx", { count: 4, phase: 3 }],
  ["panels/Editor/ConflictView.tsx", { count: 8, phase: 2 }],
  ["panels/Editor/DebugPanel.tsx", { count: 15, phase: 2 }],
  ["panels/Editor/Editor.tsx", { count: 13, phase: 3 }],
  ["panels/Editor/FileTree/FileTree.tsx", { count: 3, phase: 3 }],
  ["panels/Editor/HunkCommentInput.tsx", { count: 1, phase: 3 }],
  ["panels/Editor/LocalHistory.tsx", { count: 1, phase: 3 }],
  ["panels/Editor/ProblemsPanel.tsx", { count: 3, phase: 3 }],
  ["panels/Editor/PullRequests/PrDetail.tsx", { count: 3, phase: 3 }],
  ["panels/Editor/PullRequests/ReviewBar.tsx", { count: 1, phase: 3 }],
  ["panels/Editor/ReviewPanel.tsx", { count: 24, phase: 2 }],
  ["panels/Editor/SearchPanel.tsx", { count: 14, phase: 2 }],
  ["panels/Editor/SearchResultsBuffer.tsx", { count: 1, phase: 3 }],
  ["panels/Editor/TasksPanel.tsx", { count: 1, phase: 3 }],
  ["panels/Editor/TodoPanel.tsx", { count: 4, phase: 3 }],
  ["panels/LeftSidebar/LeftSidebar.tsx", { count: 15, phase: 5 }],
  ["panels/Settings/Settings.tsx", { count: 1, phase: 5 }],
  ["panels/Settings/paneKit.tsx", { count: 4, phase: 5 }],
  ["panels/Terminal/HistoryPanel.tsx", { count: 4, phase: 4 }],
  ["panels/Terminal/Terminal.tsx", { count: 6, phase: 4 }],
  ["panels/Terminal/TerminalView.tsx", { count: 3, phase: 4 }],
]);

const KEPT = new Map<string, Kept>([
  ["components/Button/Button.tsx", { count: 1, reason: CONTROL_PASSTHROUGH }],
  ["components/IconButton/IconButton.tsx", { count: 1, reason: CONTROL_PASSTHROUGH }],
  ["components/Dialog/Dialog.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Dialogs/AskpassDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/BranchRemoveDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ConfirmDeleteSpace.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/ConfirmDialog.test.tsx", { count: 2, reason: FIXTURE }],
  ["components/Dialogs/ConfirmDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/CreatePrDialog.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Dialogs/DebugTargetDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/InitGitDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/NewProjectDialog.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PickerModal.test.tsx", { count: 2, reason: FIXTURE }],
  ["components/Dialogs/PickerModal.tsx", { count: 1, reason: HEADING }],
  ["components/Dialogs/PromptModal.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/Dialogs/PromptModal.tsx", { count: 1, reason: HEADING }],
  [
    "components/Dialogs/WorktreeRemoveDialog.tsx",
    { count: 2, reason: `${HEADING}, plus one ${TRUNCATION}` },
  ],
  ["components/Dialogs/stackedDialogs.test.tsx", { count: 1, reason: FIXTURE }],
  ["components/ForgeChip/ForgeChip.tsx", { count: 3, reason: TRUNCATION }],
  ["components/ShortcutSheet/ShortcutSheet.tsx", { count: 1, reason: HEADING }],
  ["components/Tooltip/Tooltip.stories.tsx", { count: 1, reason: FIXTURE }],
  ["components/Tooltip/Tooltip.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/Chat/ModeSelector.tsx", { count: 1, reason: GROUP_HEADING }],
  ["panels/Chat/ModelPicker.tsx", { count: 3, reason: GROUP_HEADING }],
  ["panels/Chat/SessionStats.tsx", { count: 6, reason: TRUNCATION }],
  ["panels/Chat/UsageReadout.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/CallsPanel.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/OutlinePanel.tsx", { count: 1, reason: TRUNCATION }],
  ["panels/Editor/PullRequests/PullRequests.tsx", { count: 2, reason: TRUNCATION }],
  ["panels/Editor/SessionPanel.tsx", { count: 3, reason: TRUNCATION }],
  ["panels/LeftSidebar/branchTruncation.test.tsx", { count: 3, reason: FIXTURE }],
  ["panels/LeftSidebar/forgeChipRow.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/LeftSidebar/needsYou.test.tsx", { count: 1, reason: FIXTURE }],
  ["panels/LeftSidebar/rollupAttribution.test.tsx", { count: 2, reason: FIXTURE }],
  ["panels/LeftSidebar/sidebarStructure.test.tsx", { count: 4, reason: FIXTURE }],
  ["panels/Settings/AgentsSection.tsx", { count: 3, reason: TRUNCATION }],
  ["panels/Settings/panes/AgentsPane.tsx", { count: 1, reason: GROUP_HEADING }],
  ["panels/Settings/panes/AppearancePane.tsx", { count: 2, reason: GROUP_HEADING }],
  ["panels/Settings/panes/ChatPane.tsx", { count: 3, reason: GROUP_HEADING }],
  ["panels/Settings/panes/EditorPane.tsx", { count: 2, reason: GROUP_HEADING }],
  ["panels/Terminal/TabMark.tsx", { count: 1, reason: TRUNCATION }],
]);

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
    const unlisted = [...scan().keys()].filter(
      (path) => !PENDING_SWEEP.has(path) && !KEPT.has(path),
    );

    // The whole point of failing open: an unknown file, or a known file that
    // grew a `title=` under a component this guard has never heard of, lands
    // here rather than slipping past a tag check.
    expect(unlisted).toEqual([]);
  });

  it("holds each entry to its exact count", () => {
    const found = scan();
    const drifted: string[] = [];
    for (const [path, entry] of [...PENDING_SWEEP, ...KEPT]) {
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
    const stale = [...PENDING_SWEEP.keys(), ...KEPT.keys()].filter(
      (path) => !found.has(path),
    );

    expect(stale).toEqual([]);
  });

  it("lists no file twice", () => {
    const both = [...PENDING_SWEEP.keys()].filter((path) => KEPT.has(path));

    // A file in both lists would be exempt for two contradictory reasons, and
    // the count check would pass on whichever was read last.
    expect(both).toEqual([]);
  });

  it("states a reason for every kept file", () => {
    const unexplained = [...KEPT].filter(([, entry]) => entry.reason.length < 20);

    // "It was easier" is not a reason, and an empty string is not one either.
    expect(unexplained.map(([path]) => path)).toEqual([]);
  });

  it("reports the work left, so the sweep's progress is a number", () => {
    const remaining = [...PENDING_SWEEP.values()].reduce(
      (total, entry) => total + entry.count,
      0,
    );
    const byPhase = new Map<number, number>();
    for (const entry of PENDING_SWEEP.values()) {
      byPhase.set(entry.phase, (byPhase.get(entry.phase) ?? 0) + entry.count);
    }

    // Not an assertion about the right number, which would just be this number
    // written twice. It pins the shape - phases 2 to 5 each still have work,
    // and phase 1 has none, because phase 1 is what built the replacement.
    expect([...byPhase.keys()].sort()).toEqual([2, 3, 4, 5]);
    expect(remaining).toBeGreaterThan(0);

    // Phase 5's last task turns this into `toBe(0)` and deletes PENDING_SWEEP.
    expect(PENDING_SWEEP.size).toBeGreaterThan(0);
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
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    regions.push([match.index + match[0].length, i, match[1]]);
  }
  return regions;
}

/** The innermost tag whose attributes contain `offset`. */
function tagAt(regions: [number, number, string][], offset: number): string | null {
  let best: [number, number, string] | null = null;
  for (const region of regions) {
    if (offset >= region[0] && offset < region[1] && (!best || region[0] > best[0])) {
      best = region;
    }
  }
  return best ? best[2] : null;
}

interface TooltipSite {
  path: string;
  tag: string | null;
  hasAriaLabel: boolean;
}

function tooltipSites(): TooltipSite[] {
  const sites: TooltipSite[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    const regions = tagRegions(source);
    const prop = /\btooltip=/g;
    let match: RegExpExecArray | null;
    while ((match = prop.exec(source))) {
      const region = regions.find(
        (r) => match!.index >= r[0] && match!.index < r[1],
      );
      const tag = tagAt(regions, match.index);
      const attrs = region ? source.slice(region[0], region[1]) : "";
      sites.push({
        path,
        tag,
        hasAriaLabel: /\baria-label=/.test(attrs),
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
          !NAMED_BY_TEXT.has(site.tag),
      )
      .map((site) => `${site.path}: <${site.tag} tooltip=…>`);

    // A `tooltip` on a raw element or on a component that never declared the
    // prop is inert: it names nothing and shows nothing. Use `<Tooltip>` with
    // `label`, which is what the primitive is for.
    expect(orphaned).toEqual([]);
  });

  it("names a Tab by its own text rather than by the tooltip", () => {
    const mislabelled = tooltipSites()
      .filter((site) => site.tag != null && NAMED_BY_TEXT.has(site.tag))
      .filter((site) => site.hasAriaLabel)
      .map((site) => `${site.path}: <${site.tag} tooltip=… aria-label=…>`);

    // An `aria-label` on a tab *replaces* its visible text as the accessible
    // name rather than adding to it, so a tab labelled with its full path stops
    // answering to the name every `getByRole("tab", { name })` in the suite
    // uses. See the vault gotcha of that name.
    expect(mislabelled).toEqual([]);
  });
});
