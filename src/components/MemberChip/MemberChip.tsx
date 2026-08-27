import { createMemo, splitProps, type JSX } from "solid-js";
import { memberInitials } from "../../utils/features";
import type { ChipStyle, TintedMember } from "../../utils/featureMembers";
import styles from "./MemberChip.module.css";

/** What the chip needs to name a repo: the display name it takes initials from,
 *  and the repo path it falls back to when that name is empty. */
export type ChipMember = { displayName: string; repoPath: string };

export interface MemberChipProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "style" | "children"> {
  member: ChipMember;
  /** The Space hue on its own, for callers holding a `MemberRoot`. */
  tint?: string;
  /** Hue and rgb together, for callers holding a `TintedMember`. Wins over
   *  `tint`, since it paints both custom properties rather than one. */
  chipStyle?: ChipStyle;
  /** Squarer box for the sidebar's Feature rows. */
  size?: "sm" | "md";
  /**
   * Hide the chip from assistive tech, for a surface that names the repo in
   * adjacent text (a tab's hidden name, a section header's own label).
   *
   * Never set it with `children`: `aria-hidden` covers the subtree, so a state
   * badge inside would stop being announced.
   */
  decorative?: boolean;
  /** An announced state badge, mounted inside the box so it can corner-pin. */
  children?: JSX.Element;
}

/** A member's initials on its Space tint.
 *
 *  Decorative by request, not by default: a tab needs the chip hidden because
 *  its accessible name carries the repo already, while the sidebar's chip holds
 *  the only spoken account of a broken member. */
export default function MemberChip(props: MemberChipProps) {
  const [local, rest] = splitProps(props, [
    "member",
    "tint",
    "chipStyle",
    "size",
    "decorative",
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
        [styles.neutral]: !style(),
      }}
      style={style()}
    >
      {memberInitials(local.member)}
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
      member={props.member.member}
      chipStyle={props.member.style}
      decorative
      data-chip={props.member.member.repoPath}
      data-state={props.member.member.state.kind}
    />
  );
}
