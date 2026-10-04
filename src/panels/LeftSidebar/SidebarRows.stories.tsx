import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Folder, Tag, Unlink } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import ProjectIcon from "../../components/Icon/ProjectIcon";
import SyncMarks from "../../components/SyncMarks/SyncMarks";
import { BranchMark, WorktreeMark } from "../../components/Icon/gitMarks";
import type { MenuItem } from "../../components/Menu/rows";
import type { Rollup } from "../../utils/sessionStatus";
import type { SyncMark } from "../../utils/branchSync";
import StatusBubble from "./StatusBubble";
import { BranchRow, EmptyRow, GroupRow, MoreRow, ProjectRow } from "./SidebarRows";
import rows from "./SidebarRows.module.css";

const MENU: MenuItem[] = [
  { label: "Open in editor", onClick: () => {} },
  { label: "Reveal in Finder", onClick: () => {} },
  { separator: true },
  { label: "Remove", onClick: () => {}, danger: true },
];

function bubble(r: Partial<Rollup>): JSX.Element {
  return (
    <StatusBubble
      rollup={() => ({
        waitingForApproval: 0,
        waitingForAnswer: 0,
        prAttention: 0,
        executing: 0,
        idle: 0,
        running: 0,
        ...r,
      })}
    />
  );
}

const MARKS: Record<string, SyncMark[]> = {
  clean: [],
  ahead: [{ kind: "push", count: 3, tone: "muted", title: "3 commits to push" }],
  diverged: [
    { kind: "push", count: 2, tone: "warn", title: "2 commits to push" },
    { kind: "pull", count: 5, tone: "warn", title: "5 commits to pull" },
    { kind: "dirty", count: null, tone: "muted", title: "Uncommitted changes" },
  ],
  conflict: [
    { kind: "conflict", count: null, tone: "danger", title: "main has moved on, and 4 files would conflict" },
    { kind: "pull", count: 11, tone: "muted", title: "11 commits to pull" },
  ],
};

/** The tree's own column. `.rowScope` is where the row geometry lives - the
 *  height, the rail's x, the indent - so nothing measures right outside one.
 *  Narrow on purpose: this column is what a name has to fit in. */
function Tree(props: { children: JSX.Element }) {
  return (
    <div class={rows.rowScope} style={{ width: "260px" }}>
      {props.children}
    </div>
  );
}

const meta = {
  title: "Panels/LeftSidebar/Rows",
  component: ProjectRow,
  // A project row is the tree's unit, so it is what the args table drives. The
  // stories below that compose a whole subtree build it in a decorator instead
  // and leave these untouched.
  args: {
    name: "api",
    icon: <ProjectIcon seed="/w/api" />,
    disclosure: true,
    menu: MENU,
  },
  decorators: [(Story) => <Tree><Story /></Tree>],
} satisfies Meta<typeof ProjectRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed, which is the state most of the column is in most of the time. The
 *  rollup on the right is every session under it, since none of its branches
 *  has a row of its own to report on. */
export const Collapsed: Story = {
  args: {
    name: "api",
    icon: <ProjectIcon seed="/w/api" />,
    disclosure: true,
    menu: MENU,
    end: bubble({ executing: 2, idle: 1 }),
  },
};

/** Open: the rollup moves off the project row, because each branch under it now
 *  carries its own. The rail runs from the project's icon down through the last
 *  branch. */
export const Open: Story = {
  args: {
    name: "api",
    icon: <ProjectIcon seed="/w/api" />,
    disclosure: true,
    open: true,
    menu: MENU,
    children: (
      <>
        <BranchRow label="main" icon={<BranchMark active={false} current />} iconLabel="Current checkout" menu={MENU}
          end={<SyncMarks marks={MARKS.ahead} label="3 commits to push" />} />
        <BranchRow label="feat/billing" icon={<WorktreeMark active />} selected menu={MENU}
          end={<><SyncMarks marks={MARKS.diverged} label="diverged" />{bubble({ waitingForApproval: 1 })}</>} />
        <BranchRow label="fix/session-leak" icon={<WorktreeMark active={false} />} menu={MENU}
          end={bubble({ idle: 1 })} />
      </>
    ),
  },
};

/** A non-git folder. It has nothing to disclose, so the icon slot keeps its art
 *  through the hover and clicking the row selects the folder itself rather than
 *  opening anything. */
export const PlainFolder: Story = {
  args: {
    name: "notes",
    icon: <Icon icon={Folder} />,
    menu: MENU,
    end: bubble({ running: 1 }),
  },
};

/** A container whose worktrees did not all get their shared files. Warning hue,
 *  because this is about the project's setup and not about anything running in
 *  it, and it doubles as the one path to that page that is not a right-click. */
export const Drifted: Story = {
  args: {
    name: "web",
    icon: <ProjectIcon seed="/w/web" />,
    disclosure: true,
    menu: MENU,
    end: (
      <>
        <IconButton
          size="xs"
          class={rows.driftMark}
          icon={<Icon icon={Unlink} />}
          aria-label="web: shared files missing from a worktree"
          tooltip="2 shared files are missing from a worktree"
        />
        {bubble({ executing: 1 })}
      </>
    ),
  },
};

/** Every trailing mark a branch row can wear, on one row: the sync run, a Topic
 *  chip and the rollup. They share one auto margin so they land in the same
 *  column on every row instead of splitting the free space between them.
 *
 *  Nothing about the forge is here any more, and nothing about the current
 *  checkout: a branch with a pull request reports it on a second line
 *  (`BranchLine`), and HEAD is drawn in the row's own glyph (see `Current`), so
 *  the cluster is back to what the branch itself is doing. */
export const TheEndCluster: Story = {
  decorators: [
    () => (
      <Tree>
        <BranchRow
          label="feat/a-branch-name-long-enough-to-clip-against-the-marks"
          icon={<WorktreeMark active />}
          selected
          menu={MENU}
          end={
            <>
              <SyncMarks marks={MARKS.conflict} label="main has moved on" />
              <IconButton size="xs" class={rows.topicChip} icon={<Icon icon={Tag} />} aria-label="Open Topic Billing" tooltip="Billing" />
              {bubble({ waitingForAnswer: 1, executing: 2 })}
            </>
          }
        />
      </Tree>
    ),
  ],
};

/** A `.bare` with no worktrees. The branches are there and the working folder
 *  is not, so the folder half of the glyph goes dashed and the branch half
 *  stays solid. It used to say this in a `stub` pill at the other end of the
 *  row; the pill was a third thing in a cluster that already carries the sync
 *  run, the forge chip and the rollup. Shown against a real worktree above it,
 *  since the whole question is whether the two read apart at 16px. */
export const Stub: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<ProjectIcon seed="/w/api" />} disclosure open menu={MENU}>
          <BranchRow label="feat/billing" icon={<WorktreeMark active={false} />} menu={MENU}
            end={<SyncMarks marks={MARKS.ahead} label="3 commits to push" />} />
          <BranchRow
            label="feat/abandoned"
            icon={<WorktreeMark active={false} stub />}
            iconLabel="A .bare with no worktrees (right-click to add one or remove it)"
            menu={MENU}
          />
          <BranchRow label="main" icon={<BranchMark active={false} current />} iconLabel="Current checkout" menu={MENU} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** Git's checked-out branch, drawn in the row's own glyph: the branch tip
 *  fills and the mark steps up out of the muted tone the column rests at. It
 *  was a teal bullet in the end cluster, which put a colour on a fact that
 *  never changes while you look at it and cost a slot next to the marks that
 *  do. Shown against its neighbours, since the only question is whether one
 *  filled node reads at 16px. */
export const Current: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<ProjectIcon seed="/w/api" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} current />} iconLabel="Current checkout" menu={MENU}
            end={<SyncMarks marks={MARKS.ahead} label="3 commits to push" />} />
          <BranchRow label="release/26.9" icon={<BranchMark active={false} />} menu={MENU} />
          <BranchRow label="feat/billing" icon={<WorktreeMark active={false} current />} iconLabel="Current checkout" menu={MENU} />
          <BranchRow label="fix/session-leak" icon={<WorktreeMark active={false} />} menu={MENU} end={bubble({ idle: 1 })} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** The fill at four times the row's size, beside the mark it has to be told
 *  apart from. Under reduced motion an executing row fills BOTH nodes, which
 *  is the whole margin between "HEAD is here" and "something is running", so
 *  the two sit next to each other here. */
export const CurrentMarkSizes: Story = {
  decorators: [
    () => (
      <div style={{ display: "flex", "align-items": "center", gap: "24px", color: "var(--fg-muted)" }}>
        <BranchMark active={false} />
        <BranchMark active={false} current />
        <BranchMark active={false} size={64} />
        <BranchMark active={false} current size={64} />
        <WorktreeMark active={false} current size={64} />
      </div>
    ),
  ],
};

/** The stub mark on its own, at the size the row draws it and at four times
 *  that, because a dash pattern is the one thing that cannot be judged at
 *  16px alone. */
export const StubMarkSizes: Story = {
  decorators: [
    () => (
      <div style={{ display: "flex", "align-items": "center", gap: "24px", color: "var(--fg-muted)" }}>
        <WorktreeMark active={false} />
        <WorktreeMark active={false} stub />
        <WorktreeMark active={false} size={64} />
        <WorktreeMark active={false} stub size={64} />
      </div>
    ),
  ],
};

/** Past the cap the list cuts itself and offers the rest. The row is a branch
 *  node rather than a footer beside them, so the rail runs through it and stops
 *  on it: it is an item in the list, not a caption under one. It also carries
 *  the rollup for everything it is hiding. */
export const Truncated: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="monorepo" icon={<ProjectIcon seed="/w/mono" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} current />} iconLabel="Current checkout" menu={MENU} />
          <BranchRow label="release/26.9" icon={<BranchMark active={false} />} menu={MENU} />
          <MoreRow count={14} open={false} end={bubble({ executing: 1, idle: 3 })} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** Opened, the control says how to put it back and stops reporting: every
 *  branch it was covering for now has a row of its own. */
export const Untruncated: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="monorepo" icon={<ProjectIcon seed="/w/mono" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} />} menu={MENU} />
          <BranchRow label="release/26.9" icon={<BranchMark active={false} />} menu={MENU} end={bubble({ executing: 1 })} />
          <BranchRow label="chore/bump-deps" icon={<BranchMark active={false} />} menu={MENU} end={bubble({ idle: 3 })} />
          <MoreRow count={14} open={true} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** A fan-out group: three attempts at one question are one thing in the tree,
 *  not three unrelated worktrees sitting next to main. Closed, the header rolls
 *  up everything inside it. */
export const AttemptGroupClosed: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<ProjectIcon seed="/w/api" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} />} menu={MENU} />
          <GroupRow goal="Make the importer idempotent" count={3} open={false} end={bubble({ executing: 2, idle: 1 })} />
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** Open, the attempts nest one indent deeper and the rail re-anchors with them.
 *  Nothing re-implements it: an attempt node moves two variables and the same
 *  rules draw the deeper line and pill. */
export const AttemptGroupOpen: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<ProjectIcon seed="/w/api" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} />} menu={MENU} />
          <GroupRow goal="Make the importer idempotent" count={3} open>
            <BranchRow nested label="importer-1" icon={<WorktreeMark active />} menu={MENU} end={bubble({ executing: 1 })} />
            <BranchRow nested label="importer-2" icon={<WorktreeMark active={false} />} selected menu={MENU} end={<SyncMarks marks={MARKS.ahead} label="3 commits to push" />} />
            <BranchRow nested label="importer-3" icon={<WorktreeMark active={false} />} menu={MENU} end={bubble({ idle: 1 })} />
          </GroupRow>
        </ProjectRow>
      </Tree>
    ),
  ],
};

/** The rows that report the absence of rows. They take the branch shape and
 *  none of its affordances, so nothing about them invites a click. */
export const Empty: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="scratch" icon={<ProjectIcon seed="/tmp/scratch" />} disclosure open menu={MENU}>
          <EmptyRow>no branches</EmptyRow>
        </ProjectRow>
        <EmptyRow>no matches in this space</EmptyRow>
      </Tree>
    ),
  ],
};

/** Four projects down a column, which is the only way to check the thing that
 *  actually matters: consecutive collapsed projects sit on one rhythm, and the
 *  breathing room only appears under an expanded one. */
export const AColumn: Story = {
  decorators: [
    () => (
      <Tree>
        <ProjectRow name="api" icon={<ProjectIcon seed="/w/api" />} disclosure menu={MENU} end={bubble({ waitingForApproval: 1 })} />
        <ProjectRow name="web" icon={<ProjectIcon seed="/w/web" />} disclosure open menu={MENU}>
          <BranchRow label="main" icon={<BranchMark active={false} current />} iconLabel="Current checkout" menu={MENU} />
          <BranchRow label="feat/onboarding" icon={<WorktreeMark active />} selected menu={MENU} end={bubble({ executing: 1 })} />
        </ProjectRow>
        <ProjectRow name="infra" icon={<ProjectIcon seed="/w/infra" />} disclosure menu={MENU} />
        <ProjectRow name="notes" icon={<Icon icon={Folder} />} menu={MENU} end={bubble({ idle: 2 })} />
      </Tree>
    ),
  ],
};
