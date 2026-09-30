import { Show, createMemo, splitProps, type JSX } from "solid-js";
import { Lock } from "lucide-solid";
import Icon from "../Icon/Icon";
import ProjectIcon, { type ProjectIconSource } from "../Icon/ProjectIcon";
import type { ChipStyle, TintedMember } from "../../utils/topicMembers";
import { isReference } from "../../utils/topics";
import styles from "./MemberChip.module.css";

export interface MemberChipProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "style" | "children"> {
  icon: ProjectIconSource;
  /** The Space hue on its own, for callers holding a `MemberRoot`. */
  tint?: string;
  /** Hue and rgb together, for callers holding a `TintedMember`. Wins over
   *  `tint`, since it paints both custom properties rather than one. */
  chipStyle?: ChipStyle;
  /** Squarer box for the sidebar's Topic rows. */
  size?: "sm" | "md";
  /** An outlined square, for the collapsed Topic row, where a run of chips has
   *  to read at a glance. */
  outlined?: boolean;
  /**
   * Hide the chip from assistive tech, for a surface that names the repo in
   * adjacent text (a tab's hidden name, a section header's own label).
   *
   * Never set it with `children`: `aria-hidden` covers the subtree, so a state
   * badge inside would stop being announced.
   */
  decorative?: boolean;
  /** A reference member: the repo's own checkout, read for context and never
   *  changed. Drawn as a lock in the corner no other badge uses. */
  reference?: boolean;
  /** An announced state badge, mounted inside the box so it can corner-pin. */
  children?: JSX.Element;
}

/** A member's project icon on its Space tint.
 *
 *  Decorative by request, not by default: a tab needs the chip hidden because
 *  its accessible name carries the repo already, while the sidebar's chip holds
 *  the only spoken account of a broken member. */
export default function MemberChip(props: MemberChipProps) {
  const [local, rest] = splitProps(props, [
    "icon",
    "tint",
    "chipStyle",
    "size",
    "outlined",
    "decorative",
    "reference",
    "children",
    "class",
    "classList",
  ]);

  const style = createMemo<ChipStyle | { "--chip-hue": string } | undefined>(
    () => local.chipStyle ?? (local.tint ? { "--chip-hue": local.tint } : undefined),
  );

  return (
    <span
      {...rest}
      aria-hidden={local.decorative ? "true" : undefined}
      class={local.class}
      classList={{
        ...local.classList,
        [styles.chip]: true,
        [styles.md]: local.size === "md",
        [styles.outlined]: !!local.outlined,
        [styles.neutral]: !style(),
      }}
      style={style()}
    >
      <ProjectIcon {...local.icon} />
      <Show when={local.reference}>
        <span class={styles.lock} role="img" aria-label="Reference, read only" data-reference>
          <Icon icon={Lock} />
        </span>
      </Show>
      {local.children}
    </span>
  );
}

/** The chip a tab, its overflow row and the crumb trail all wear.
 *
 *  Decorative, because the row's own text already names the repo; `data-state`
 *  rides along so a member that cannot be opened right now still says so. */
export function TabMemberChip(props: { member: TintedMember }) {
  return (
    <MemberChip
      icon={props.member.icon}
      chipStyle={props.member.style}
      decorative
      reference={isReference(props.member.member)}
      data-chip={props.member.member.repoPath}
      data-state={props.member.member.state.kind}
    />
  );
}
