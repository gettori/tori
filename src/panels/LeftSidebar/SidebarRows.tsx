import { Show, type JSX } from "solid-js";
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, Layers } from "lucide-solid";
import ContextMenu from "../../components/Menu/ContextMenu";
import { type MenuItem } from "../../components/Menu/rows";
import Icon from "../../components/Icon/Icon";
import styles from "./SidebarRows.module.css";

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
  /** The trailing mark cluster: drift, forge door, rollup. */
  end?: JSX.Element;
  menu?: MenuItem[];
  onClick?: () => void;
  onDragStart?: (e: DragEvent) => void;
  children?: JSX.Element;
}) {
  return (
    <div class={`node ${styles.projectCard}`} data-no-window-drag>
      <ContextMenu
        class={`${styles.row} ${styles.project}`}
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
        </span>
        <span class={styles.label}>{props.name}</span>
        <span class={styles.rowEnd}>{props.end}</span>
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
  nested?: boolean;
  end?: JSX.Element;
  /** A second line under the name, for a branch whose pull request has more to
   *  say than the end cluster has width for (`PrLine`). Absent leaves the row
   *  exactly the single-line shape it has always had, which is most rows. */
  meta?: JSX.Element;
  menu?: MenuItem[];
  onClick?: () => void;
  onDragStart?: (e: DragEvent) => void;
}) {
  const glyph = () => (
    <span class={styles.rowIcon} title={props.iconLabel}>{props.icon}</span>
  );
  const name = () => <span class={styles.label}>{props.label}</span>;
  const end = () => <span class={styles.rowEnd}>{props.end}</span>;
  return (
    <div class={`node ${styles.branchNode}`} classList={{ [styles.attemptNode]: props.nested }}>
      <ContextMenu
        class={`${styles.row} ${styles.branch} ${styles.sub1} ${props.selected ? styles.sel : ""}`}
        data-two-line={props.meta != null ? "true" : undefined}
        onClick={() => props.onClick?.()}
        items={props.menu ?? []}
        draggable={true}
        onDragStart={(e: DragEvent) => props.onDragStart?.(e)}
        aria-current={props.selected ? "true" : undefined}
      >
        {/* The glyph rides inside the first line rather than beside the pair
            of them. Centred against the whole stack it belongs to neither
            line, and centred against the row's top by a computed offset it
            only ever approximates the label's line box - which has no stated
            line-height to compute from. In here `.rowTop` IS a single-line
            row, so the two shapes cannot drift apart. */}
        <Show when={props.meta} fallback={<>{glyph()}{name()}{end()}</>}>
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
 * The truncation control at the foot of a long branch list: "N more branches"
 * while the list is cut, "Show less" once it is open.
 *
 * Rendered as a branch node rather than as a footer beside them, so the rail
 * runs through it and stops on it: it is an item in the list, not a caption
 * under one. Being a branch node it takes the rail, the hover pill and the
 * label x for free.
 */
export function MoreRow(props: {
  count: number;
  open: boolean;
  /** The rollup for the branches this row is hiding, when it is hiding any. */
  end?: JSX.Element;
  onClick?: () => void;
}) {
  return (
    <div class={`node ${styles.branchNode}`}>
      <div
        class={`${styles.row} ${styles.branch} ${styles.sub1} ${styles.moreRow}`}
        onClick={() => props.onClick?.()}
      >
        <span class={styles.rowIcon}>
          <Icon icon={props.open ? ChevronUp : Ellipsis} />
        </span>
        <span class={styles.label}>
          {props.open ? "Show less" : `${props.count} more branch${props.count === 1 ? "" : "es"}`}
        </span>
        {props.end}
      </div>
    </div>
  );
}

/** One fan-out group: the goal as the header, its attempts nested beneath.
 *  Grouping is the whole point - three attempts at one question are one thing
 *  in the tree, not three unrelated worktrees sitting next to `main`. */
export function GroupRow(props: {
  goal: string;
  count: number;
  open: boolean;
  end?: JSX.Element;
  onClick?: () => void;
  children?: JSX.Element;
}) {
  return (
    <div class={`node ${styles.branchNode}`}>
      <div
        class={`${styles.row} ${styles.branch} ${styles.sub1}`}
        onClick={() => props.onClick?.()}
        title={props.goal}
      >
        {/* Layers, not a fork: the row names the shared goal, and the forks are
            the attempt rows nested under it. It carries an icon at all so every
            branch-level row lines its label up on the same x. */}
        <span class={styles.rowIcon}><Icon icon={Layers} /></span>
        <span class={styles.label}>{props.goal}</span>
        <span
          class={`${styles.badge} ${styles.hint}`}
          title="Independent attempts at one task. Promote one and the rest are discarded."
        >
          {props.count === 1 ? "1 attempt" : `${props.count} attempts`}
        </span>
        {props.end}
        <RowChevron open={props.open} />
      </div>
      {props.children}
    </div>
  );
}

/** "no branches", "no matches in this space": a row that reports the absence of
 *  rows, so it takes their shape and none of their affordances. */
export function EmptyRow(props: { children: JSX.Element }) {
  return <div class={`${styles.row} ${styles.dim} ${styles.sub1}`}>{props.children}</div>;
}
