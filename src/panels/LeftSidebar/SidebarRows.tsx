import type { SidebarDragProps } from "./sidebarDrag";
import { For, Show, onMount, type JSX } from "solid-js";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleX,
  Ellipsis,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Layers,
  MessageSquare,
  Plus,
  RefreshCw,
  SquareStack,
  TriangleAlert,
  type LucideIcon,
} from "lucide-solid";
import ContextMenu from "../../components/Menu/ContextMenu";
import Dropdown from "../../components/Menu/Dropdown";
import IconButton from "../../components/IconButton/IconButton";
import { type MenuItem } from "../../components/Menu/rows";
import Icon from "../../components/Icon/Icon";
import type { DragRowProps } from "../../utils/dragReorder";
import { HUE_VARS, LANE_LABEL, type CardHue, type LaneId } from "../../utils/prLanes";
import styles from "./SidebarRows.module.css";

/** The mark on a project tile that says the folder was attached from
 *  elsewhere, worn wherever the project is drawn. */
export function AliasBadge() {
  return (
    <span class={styles.aliasBadge} role="img" aria-label="Attached folder">
      <Icon icon={ArrowUpRight} />
    </span>
  );
}

/** Trailing disclosure chevron for sidebar rows: a Lucide chevron-down pinned
 *  to the row's right edge that flips to a chevron-up (rotate 180°) when
 *  expanded. */
export function RowChevron(props: { open: boolean }) {
  return (
    <span class={styles.rowChevron} classList={{ [styles.open]: props.open }}>
      <Icon icon={ChevronDown} />
    </span>
  );
}

/** A project row's disclosure, drawn *in* the icon slot rather than beside it:
 *  at rest the row shows what the project is, and under the pointer it shows
 *  what clicking does. One slot, two jobs, and the row keeps a single glyph. */
export function IconChevron(props: { open: boolean }) {
  return (
    <span class={styles.iconChevron} aria-hidden="true">
      <Icon icon={props.open ? ChevronDown : ChevronRight} />
    </span>
  );
}

/**
 * A project and everything under it. The card is the group's left edge and the
 * anchor its branch rows' rail hangs off; the branch rows themselves arrive as
 * `children`, so the caller keeps the disclosure gate.
 *
 * Rows are clickable `div`s, which window drag cannot tell from chrome by
 * selector, so the card opts its whole subtree out of it (utils/windowDrag).
 */
export function ProjectRow(props: {
  name: string;
  /** The project's own art: a Lucide glyph, its favicon, or an uploaded image. */
  icon: JSX.Element;
  /** Whether the icon slot cross-fades to a chevron under the pointer. A folder
   *  with no branches under it has nothing to disclose, so it keeps its icon. */
  disclosure?: boolean;
  open?: boolean;
  /** This project's settings are on screen in an editor pane. */
  editing?: boolean;
  /** The trailing mark cluster: drift, forge door, rollup. */
  end?: JSX.Element;
  attached?: { parent: string; full: string };
  missing?: boolean;
  menu?: MenuItem[];
  onClick?: () => void;
  onDragStart?: (e: DragEvent) => void;
  children?: JSX.Element;
}) {
  return (
    <div class={`node ${styles.projectCard}`} data-no-window-drag>
      <ContextMenu
        class={`${styles.row} ${styles.project} ${props.editing ? styles.editing : ""}`.trim()}
        classList={{ [styles.missing]: !!props.missing, [styles.attached]: !!props.attached }}
        onClick={() => props.onClick?.()}
        items={props.menu ?? []}
        draggable={true}
        onDragStart={(e: DragEvent) => props.onDragStart?.(e)}
      >
        <span class={`${styles.rowIcon} ${styles.projectIcon}`}>
          <span class={styles.projectIconArt}>{props.icon}</span>
          <Show when={props.disclosure}>
            <IconChevron open={props.open === true} />
          </Show>
          <Show when={props.attached}>
            <AliasBadge />
          </Show>
        </span>
        <span class={styles.label} title={props.attached?.full}>
          {props.name}
        </span>
        <Show
          when={!props.missing}
          fallback={
            <span class={styles.rowEnd}>
              <span class={styles.missingMark} role="img" aria-label="Folder missing">
                <Icon icon={TriangleAlert} />
              </span>
            </span>
          }
        >
          <span class={styles.rowEnd}>
            {props.end}
            <Show when={props.attached}>{(a) => <span class={styles.attachedPath}>{a().parent}</span>}</Show>
          </span>
        </Show>
        <Show when={props.menu?.length}>
          {/* Stops the click so opening the menu does not also toggle the row. */}
          <span class={styles.rowMenu} onClick={(e) => e.stopPropagation()}>
            <Dropdown as="span" wrapper items={props.menu} placement="bottom-end">
              <IconButton
                size="sm"
                class={styles.rowMenuBtn}
                icon={<Icon icon={Ellipsis} />}
                tooltip={`Actions for ${props.name}`}
              />
            </Dropdown>
          </span>
        </Show>
      </ContextMenu>
      {props.children}
    </div>
  );
}

/** One branch-unit under a project: a worktree, a branch of a plain repo, a
 *  non-git folder, or a stub. `nested` is an attempt sitting under its fan-out
 *  group, which re-anchors the rail one indent to the right. */
export function BranchRow(props: {
  label: string;
  icon: JSX.Element;
  /** What the glyph says, for the one state it carries that the label does not:
   *  a stub's dashed folder. The mark itself is `aria-hidden`, and the slot
   *  around it is unreachable by keyboard, so this is hover text on something
   *  no Tab can land on rather than a tooltip nobody could open. */
  iconLabel?: string;
  selected?: boolean;
  picked?: boolean;
  nested?: boolean;
  look?: "done" | "closed" | null;
  /** A mark between the glyph and the name, e.g. the autopilot's wheel on a
   *  worktree it started. */
  lead?: JSX.Element;
  end?: JSX.Element;
  /** A second line under the name, for a branch whose pull request has more to
   *  say than the end cluster has width for (`BranchLine`). Absent leaves the row
   *  exactly the single-line shape it has always had, which is most rows. */
  meta?: JSX.Element;
  menu?: MenuItem[];
  onClick?: (e: MouseEvent) => void;
  onDragStart?: (e: DragEvent) => void;
  /** Spread on the row last, for a caller that keys or reorders its rows (a
   *  Topic's members carry `data-member` and the drag-reorder handlers). */
  rowProps?: (Partial<DragRowProps> & { [data: `data-${string}`]: string | undefined }) | SidebarDragProps;
}) {
  const glyph = () => (
    <span class={styles.rowIcon} title={props.iconLabel}>
      {props.icon}
    </span>
  );
  const name = () => (
    <>
      {props.lead}
      <span class={styles.label}>{props.label}</span>
    </>
  );
  const end = () => <span class={styles.rowEnd}>{props.end}</span>;
  return (
    <div class={`node ${styles.branchNode}`} classList={{ [styles.attemptNode]: props.nested }}>
      <ContextMenu
        class={`${styles.row} ${styles.branch} ${styles.sub1} ${props.selected ? styles.sel : ""} ${props.look ? styles[props.look] : ""}`}
        classList={{ [styles.picked]: props.picked === true }}
        data-two-line={props.meta != null ? "true" : undefined}
        onClick={(e: MouseEvent) => props.onClick?.(e)}
        items={props.menu ?? []}
        draggable={true}
        onDragStart={(e: DragEvent) => props.onDragStart?.(e)}
        aria-current={props.selected ? "true" : undefined}
        {...props.rowProps}
      >
        {/* The glyph rides inside the first line rather than beside the pair
            of them. Centred against the whole stack it belongs to neither
            line, and centred against the row's top by a computed offset it
            only ever approximates the label's line box - which has no stated
            line-height to compute from. In here `.rowTop` IS a single-line
            row, so the two shapes cannot drift apart. */}
        <Show
          when={props.meta}
          fallback={
            <>
              {glyph()}
              {name()}
              {end()}
            </>
          }
        >
          {(meta) => (
            <span class={styles.rowStack}>
              <span class={styles.rowTop}>
                {glyph()}
                {name()}
                {end()}
              </span>
              <span class={styles.rowMeta}>{meta()}</span>
            </span>
          )}
        </Show>
      </ContextMenu>
    </div>
  );
}

/**
 * The truncation control at the foot of a long list of rail rows (branches,
 * chats): "N more branches" while the list is cut, "Show less" once it is
 * open, or the chats' "Older".
 *
 * Rendered as a branch node rather than as a footer beside them, so the rail
 * runs through it and stops on it: it is an item in the list, not a caption
 * under one. Being a branch node it takes the rail, the hover pill and the
 * label x for free.
 */
export function MoreRow(props: {
  label: string;
  open: boolean;
  /** The rollup for the rows this one is hiding, when it is hiding any. */
  end?: JSX.Element;
  onClick?: () => void;
}) {
  return (
    <div class={`node ${styles.branchNode}`}>
      <button
        type="button"
        class={`${styles.row} ${styles.branch} ${styles.sub1} ${styles.moreRow}`}
        aria-expanded={props.open}
        onClick={() => props.onClick?.()}
      >
        <span class={styles.rowIcon}>
          <Icon icon={props.open ? ChevronUp : Ellipsis} />
        </span>
        <span class={styles.label}>{props.label}</span>
        {props.end}
      </button>
    </div>
  );
}

/** `MoreRow`'s look at the foot of a capped list of cards (Topics, projects).
 *  Those lists have no rail, so it sits at card depth with none through it. */
export function FoldRow(props: {
  label: string;
  open: boolean;
  /** The rollup for what this row is hiding, when it is hiding anything. */
  end?: JSX.Element;
  onClick?: () => void;
}) {
  return (
    <div class={styles.projectCard} data-no-window-drag>
      <button
        type="button"
        class={`${styles.row} ${styles.moreRow}`}
        aria-expanded={props.open}
        onClick={() => props.onClick?.()}
      >
        <span class={styles.rowIcon}>
          <Icon icon={props.open ? ChevronUp : Ellipsis} />
        </span>
        <span class={styles.label}>{props.label}</span>
        <span class={styles.rowEnd}>{props.end}</span>
      </button>
    </div>
  );
}

/** A header that gathers related branch rows one indent deeper: a fan-out's
 *  attempts at one goal, or the local layers of one stack. Grouping is the
 *  whole point - three attempts at one question are one thing in the tree, not
 *  three unrelated worktrees sitting next to `main`. */
export function GroupRow(props: {
  label: string;
  /** Carried at all so every branch-level row lines its label up on the same x. */
  icon: LucideIcon;
  badge: string;
  hint: string;
  open: boolean;
  end?: JSX.Element;
  onClick?: () => void;
  children?: JSX.Element;
  rowProps?: SidebarDragProps;
}) {
  return (
    <div class={`node ${styles.branchNode}`}>
      <div
        class={`${styles.row} ${styles.branch} ${styles.sub1}`}
        onClick={() => props.onClick?.()}
        title={props.label}
        {...props.rowProps}
      >
        <span class={styles.rowIcon}>
          <Icon icon={props.icon} />
        </span>
        <span class={styles.label}>{props.label}</span>
        <span class={`${styles.badge} ${styles.hint}`} title={props.hint}>
          {props.badge}
        </span>
        {props.end}
        <RowChevron open={props.open} />
      </div>
      {props.children}
    </div>
  );
}

export type GroupNameDraft = { text: string; start: number; end: number };

/** A custom group: a card with its name and count on the header and its
 *  member rows inside. The draft lives with the caller, because a config
 *  reload remounts the whole tree and the editor has to come back as it was. */
export function GroupCard(props: {
  name: string;
  count: number;
  open: boolean;
  holdsSelection?: boolean;
  draft?: GroupNameDraft | null;
  onDraft?: (draft: GroupNameDraft) => void;
  onRename?: (name: string | null) => void;
  menu?: MenuItem[];
  onToggle?: () => void;
  rowProps?: SidebarDragProps;
  /** The group's colour as a hex, or none. */
  tint?: string | null;
  children?: JSX.Element;
}) {
  const editor = (draft: () => GroupNameDraft) => {
    let input!: HTMLInputElement;
    const keep = () =>
      props.onDraft?.({ text: input.value, start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 });
    onMount(() => {
      input.focus();
      input.setSelectionRange(draft().start, draft().end);
    });
    return (
      <input
        ref={input}
        class={styles.groupName}
        value={draft().text}
        aria-label="Group name"
        onClick={(e) => e.stopPropagation()}
        onInput={keep}
        onSelect={keep}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") props.onRename?.(input.value);
          else if (e.key === "Escape") props.onRename?.(null);
        }}
        // A reload remounts the tree, and the new editor takes focus on mount;
        // only a blur that leaves no editor focused is the user moving on.
        onBlur={() =>
          setTimeout(() => {
            if (
              !(
                document.activeElement instanceof HTMLInputElement &&
                document.activeElement.getAttribute("aria-label") === "Group name"
              )
            )
              props.onRename?.(input.value);
          })
        }
      />
    );
  };
  return (
    <div
      class={`node ${styles.groupCard}`}
      data-group={props.name}
      data-hue={props.tint ? "" : undefined}
      style={props.tint ? tintVars(props.tint) : undefined}
    >
      <ContextMenu
        class={`${styles.row} ${styles.cardHead}`}
        classList={{ [styles.cardHeadSel]: props.holdsSelection === true, [styles.cardHeadOpen]: props.open }}
        items={props.menu ?? []}
        onClick={() => props.onToggle?.()}
        aria-expanded={props.open}
        {...props.rowProps}
      >
        <Show when={props.draft} fallback={<span class={`${styles.label} ${styles.cardLabel}`}>{props.name}</span>}>
          {(draft) => editor(draft)}
        </Show>
        <span class={styles.cardCount}>{props.count}</span>
        <RowChevron open={props.open} />
      </ContextMenu>
      <Show when={props.open}>
        <div class={styles.cardBody}>{props.children}</div>
      </Show>
    </div>
  );
}

/** A group card washed in its own colour, mixed down into the card the way the
 *  lane hues are, so it reads in either theme. */
const tintVars = (hex: string) => ({
  "--card-head": `color-mix(in srgb, ${hex} 7%, var(--lane-card))`,
  "--card-body": `color-mix(in srgb, ${hex} 4%, var(--lane-card))`,
  "--card-icon": hex,
});

const LANE_ICON: Record<LaneId, LucideIcon> = {
  working: Activity,
  inReview: GitPullRequest,
  reviewing: Eye,
  done: GitMerge,
  noPr: GitBranch,
  draft: GitPullRequestDraft,
  ready: GitPullRequest,
  commented: MessageSquare,
  changesRequested: CircleX,
  reReview: RefreshCw,
  approved: CircleCheck,
  reviewRequested: Eye,
  reviewed: Check,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** An open lane. Its header parks it. */
export function LaneCard(props: {
  lane: LaneId;
  count: number;
  onPark: () => void;
  hue?: CardHue | null;
  children?: JSX.Element;
}) {
  return (
    <div
      class={`node ${styles.groupCard}`}
      data-lane={props.lane}
      data-hue={props.hue ?? undefined}
      style={props.hue ? HUE_VARS[props.hue] : undefined}
    >
      <button
        type="button"
        class={`${styles.row} ${styles.cardHead} ${styles.cardHeadOpen}`}
        aria-expanded="true"
        onClick={() => props.onPark()}
      >
        <span class={styles.rowIcon}>
          <Icon icon={LANE_ICON[props.lane]} />
        </span>
        <span class={`${styles.label} ${styles.cardLabel}`}>{LANE_LABEL[props.lane]}</span>
        <span class={styles.cardCount}>{props.count}</span>
        <RowChevron open />
      </button>
      <div class={styles.cardBody}>{props.children}</div>
    </div>
  );
}

export type ParkedLane = { lane: LaneId; count: number; holdsSelection: boolean; hue?: CardHue | null };

/** The parked lanes side by side. A click opens one in its place. */
export function ParkedLanes(props: { lanes: ParkedLane[]; onOpen: (lane: LaneId) => void }) {
  return (
    <div class={`node ${styles.parkedRow}`}>
      <For each={props.lanes}>
        {(l) => (
          <button
            type="button"
            class={styles.parkedCard}
            classList={{ [styles.cardHeadSel]: l.holdsSelection }}
            data-lane={l.lane}
            data-hue={l.hue ?? undefined}
            style={l.hue ? HUE_VARS[l.hue] : undefined}
            aria-expanded="false"
            onClick={() => props.onOpen(l.lane)}
          >
            <Icon icon={LANE_ICON[l.lane]} />
            <span class={styles.parkedName}>{LANE_LABEL[l.lane]}</span>
            <span class={styles.cardCount}>{l.count}</span>
          </button>
        )}
      </For>
    </div>
  );
}

/** A fan-out group's header. Layers, not a fork: the row names the shared
 *  goal, and the forks are the attempt rows nested under it. */
export const attemptGroup = (goal: string, count: number) => ({
  label: goal,
  icon: Layers,
  badge: count === 1 ? "1 attempt" : `${count} attempts`,
  hint: "Independent attempts at one task. Promote one and the rest are discarded.",
});

/** A stack's header. The stack's own number is left off: GitHub draws it from
 *  the pull request counter, so beside the layers' `#475` it reads as one more
 *  pull request. `size` counts every layer, local or not. */
export const stackGroup = (size: number, baseRef: string) => ({
  label: "Stack",
  icon: SquareStack,
  badge: `${size} PRs -> ${baseRef}`,
  hint: "Pull requests stacked on GitHub, top layer first. Only the layers you have locally are listed.",
});

/** The branch a stack lands on, at the foot of its layers the way GitHub's
 *  stack map draws it. Inert: the branch has its own row in the list. */
export function TrunkRow(props: { name: string }) {
  return (
    <div class={`node ${styles.branchNode} ${styles.attemptNode}`}>
      <div class={`${styles.row} ${styles.sub1} ${styles.trunkRow}`}>
        <span class={styles.rowIcon}>
          <Icon icon={GitBranch} />
        </span>
        <span class={styles.label}>{props.name}</span>
      </div>
    </div>
  );
}

/** "no branches", "no matches in this space": a row that reports the absence of
 *  rows, so it takes their shape and none of their affordances. */
export function EmptyRow(props: { children: JSX.Element }) {
  return <div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>{props.children}</div>;
}

/** The heading over one kind of row in a space's tree: `TOPICS` over its
 *  Topics, `PROJECTS 5` over its projects. With `onToggle` the label is the
 *  group's disclosure, and the count shows only while the group is shut or a
 *  filter narrows it; `onAdd` puts a `+` at the right edge, shown on hover. */
export function GroupHead(props: {
  label: string;
  count: string;
  open?: boolean;
  filtered?: boolean;
  onToggle?: () => void;
  end?: JSX.Element;
  addLabel?: string;
  onAdd?: () => void;
}) {
  const title = () => (
    <>
      <span class={styles.groupLabel}>{props.label}</span>
      <Show when={!props.onToggle || !props.open || props.filtered}>
        <span class={styles.groupCount}>{props.count}</span>
      </Show>
    </>
  );
  return (
    <div class={styles.groupHead} data-group-head={props.label}>
      <Show when={props.onToggle} fallback={<span class={styles.groupTitle}>{title()}</span>}>
        <button
          type="button"
          class={styles.groupTitle}
          aria-expanded={props.open === true}
          onClick={() => props.onToggle?.()}
        >
          <Icon icon={props.open ? ChevronDown : ChevronRight} class={styles.groupChevron} />
          {title()}
        </button>
      </Show>
      <span class={styles.rowEnd}>{props.end}</span>
      <Show when={props.onAdd}>
        <IconButton
          size="xs"
          class={styles.groupAdd}
          icon={<Icon icon={Plus} />}
          aria-label={props.addLabel}
          tooltip={props.addLabel}
          onClick={() => props.onAdd?.()}
        />
      </Show>
    </div>
  );
}
