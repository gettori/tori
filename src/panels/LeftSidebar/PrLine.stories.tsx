import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { WorktreeMark } from "../../components/Icon/gitMarks";
import SyncMarks from "../../components/SyncMarks/SyncMarks";
import type { MenuItem } from "../../components/Menu/rows";
import type {
  CheckState,
  PrState,
  ReviewDecision,
  UnitStatus,
} from "../../utils/forgeTypes";
import PrLine from "./PrLine";
import { BranchRow, ProjectRow } from "./SidebarRows";
import rows from "./SidebarRows.module.css";

const MENU: MenuItem[] = [
  { label: "Open pull request", onClick: () => {} },
  { label: "New session", onClick: () => {} },
];

/** A poll answer for one branch. Everything here is a field `UnitStatus`
 *  already carries, which is the point of the exercise: the whole line below
 *  is buildable today except `age` and `comments`. */
function status(o: {
  number: number;
  title?: string;
  state?: PrState;
  isDraft?: boolean;
  /** Hours back from now, so the rendered age stays right whenever the story
   *  is opened rather than ageing into `4y` the way a fixed date would. */
  openedHoursAgo?: number;
  comments?: number;
  checks?: CheckState;
  total?: number;
  failing?: number;
  review?: ReviewDecision;
}): UnitStatus {
  return {
    headRef: "feat/thing",
    pullRequest: {
      number: o.number,
      title: o.title ?? "Only scroll sideways when the target cell is clipped",
      body: null,
      state: o.state ?? "open",
      isDraft: o.isDraft ?? false,
      createdAt: new Date(Date.now() - (o.openedHoursAgo ?? 20) * 3600_000).toISOString(),
      comments: o.comments ?? 0,
      author: "skarif",
      headRef: "feat/thing",
      baseRef: "main",
      headSha: "abc1234",
      url: `https://github.com/gettori/tori/pull/${o.number}`,
      mergeableState: "clean",
    },
    checks: {
      state: o.checks ?? "success",
      total: o.total ?? 4,
      failing: o.failing ?? 0,
    },
    reviewDecision: o.review ?? "reviewRequired",
  };
}

const NO_PR: UnitStatus = {
  headRef: "main",
  pullRequest: null,
  checks: { state: "none", total: 0, failing: 0 },
  reviewDecision: "none",
};

/** The rail, at the width the column actually has. Every judgement on this
 *  page is a judgement about what survives 260px. */
function Tree(props: { children: JSX.Element }) {
  return (
    <div class={rows.rowScope} style={{ width: "260px" }}>
      {props.children}
    </div>
  );
}

const meta = {
  title: "Panels/LeftSidebar/PrLine",
  component: PrLine,
  args: { status: status({ number: 7875, comments: 2 }) },
  decorators: [(Story) => <Tree><Story /></Tree>],
} satisfies Meta<typeof PrLine>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole line: number, age, review verdict, check score, comments. */
export const Default: Story = {};

/** The narrowest it gets. Nobody has reviewed, nobody has commented and the
 *  repo has no CI, so four of the five facts have nothing to report and the
 *  line is a number and an age. Each absent fact takes its separator with it,
 *  which is why the run cannot end on a dangling dot. */
export const Quiet: Story = {
  args: { status: status({ number: 7875, review: "none", checks: "none" }) },
};

/** Every state the line can report, stacked. The checks keep their own colour
 *  and everything else stays recessive, which is the one rule the line has. */
export const States: Story = {
  decorators: [
    () => (
      <Tree>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <PrLine status={status({ number: 7875, review: "approved", comments: 2 })} />
          <PrLine status={status({ number: 7865, checks: "failure", total: 5, failing: 1, comments: 3, openedHoursAgo: 48 })} />
          <PrLine status={status({ number: 7864, checks: "pending", total: 4, openedHoursAgo: 48 })} />
          <PrLine status={status({ number: 7862, review: "changesRequested", checks: "failure", total: 5, failing: 1, comments: 19, openedHoursAgo: 72 })} />
          <PrLine status={status({ number: 7861, isDraft: true, checks: "none", openedHoursAgo: 72 })} />
          <PrLine status={status({ number: 7860, state: "merged", review: "approved", comments: 14, openedHoursAgo: 24 * 8 })} />
          <PrLine status={status({ number: 7859, state: "closed", checks: "none", openedHoursAgo: 24 * 15 })} />
        </div>
      </Tree>
    ),
  ],
};

/** What this is actually for: the column. Two branches have a pull request and
 *  grow a line; the rest say nothing, which is what lets the `no pull request`
 *  marker come off every row that has not got one. Compare the density against
 *  Rows/AColumn, where every row carried a chip. */
export const InTheColumn: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<WorktreeMark active={false} />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<WorktreeMark active={false} current />} iconLabel="Current checkout" menu={MENU} />
          <BranchRow
            label="feat/sideways-scroll"
            icon={<WorktreeMark active />}
            menu={MENU}
            end={<SyncMarks marks={[{ kind: "push", count: 3, tone: "muted", title: "3 commits to push" }]} label="3 commits to push" />}
            meta={<PrLine status={status({ number: 7875, review: "approved", comments: 2 })} />}
          />
          <BranchRow label="chore/bump-deps" icon={<WorktreeMark active={false} />} menu={MENU} />
          <BranchRow
            label="fix/zoned-sections-tabbed-rundowns"
            icon={<WorktreeMark active={false} />}
            selected
            menu={MENU}
            meta={<PrLine status={status({ number: 7865, checks: "failure", total: 5, failing: 1, comments: 3, openedHoursAgo: 48 })} />}
          />
          <BranchRow label="spike/whatever" icon={<WorktreeMark active={false} />} menu={MENU} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** The alignment check. Four rows alternating single-line and two-line, all
 *  wearing the same glyph: read straight down the icon column and the two
 *  shapes have to sit on one line. They are not offset into agreement, they
 *  are the same construction - a two-line row's first line is a single-line
 *  row, with the second hung underneath it. */
export const GlyphAlignment: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<WorktreeMark active={false} />} disclosure open menu={MENU}>
          <BranchRow label="one-line-above" icon={<WorktreeMark active={false} />} menu={MENU} />
          <BranchRow
            label="two-line"
            icon={<WorktreeMark active={false} />}
            menu={MENU}
            meta={<PrLine status={status({ number: 7875, review: "approved", comments: 2 })} />}
          />
          <BranchRow label="one-line-between" icon={<WorktreeMark active={false} />} menu={MENU} />
          <BranchRow
            label="two-line-selected"
            icon={<WorktreeMark active={false} />}
            selected
            menu={MENU}
            meta={<PrLine status={status({ number: 7865, checks: "failure", total: 5, failing: 1, comments: 3 })} />}
          />
          <BranchRow label="one-line-below" icon={<WorktreeMark active={false} />} menu={MENU} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** A branch with no pull request renders no line at all, gate included: the
 *  component itself refuses rather than trusting every call site to check. */
export const NoPullRequest: Story = {
  args: { status: NO_PR },
};
