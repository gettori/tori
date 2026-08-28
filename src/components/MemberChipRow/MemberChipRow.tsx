import { createMemo, For, Show } from "solid-js";
import Dropdown from "../Menu/Dropdown";
import Tooltip from "../Tooltip/Tooltip";
import { memberInitials } from "../../utils/features";
import { CHIP_CAP, type TintedMember } from "../../utils/featureMembers";
import styles from "./MemberChipRow.module.css";

/**
 * Which member the pane below is about, and the control that moves it.
 *
 * The right panel's Pull requests, Tasks, Shared and Docs each answer for one
 * repo, and a Feature has several; without this row the pane silently reports
 * whichever member was last clicked in the tree. The Toolbar's crumb chips move
 * the same pointer, so the two read alike on purpose.
 *
 * Capped at `CHIP_CAP`, the sidebar's number, with the rest behind `+N`.
 */
export default function MemberChipRow(props: {
  members: readonly TintedMember[];
  /** The member folder the workspace is pointed at. */
  activeRoot: string | null;
  onActiveRoot?: (root: string) => void;
}) {
  const isActive = (m: TintedMember) =>
    !!m.member.worktreePath && m.member.worktreePath === props.activeRoot;

  /** The chips the row draws, and the ones behind `+N`.
   *
   *  The active member is never hidden. A row whose whole job is to say which
   *  member the pane below is about, and which cannot show that member, is
   *  worse than one that drops a different one: it takes the last visible slot
   *  rather than growing the row past the cap. */
  const split = createMemo(() => {
    const all = [...props.members];
    if (all.length <= CHIP_CAP) return { shown: all, hidden: [] as TintedMember[] };
    const shown = all.slice(0, CHIP_CAP);
    const active = all.find(isActive);
    if (active && !shown.includes(active)) shown[CHIP_CAP - 1] = active;
    return { shown, hidden: all.filter((m) => !shown.includes(m)) };
  });

  const nameOf = (m: TintedMember) => (m.state.usable ? m.label : `${m.label}: ${m.state.label}`);
  const switchTo = (m: TintedMember) => {
    if (m.member.worktreePath) props.onActiveRoot?.(m.member.worktreePath);
  };

  return (
    <div class={styles.row} role="group" aria-label="Feature members">
      <For each={split().shown}>
        {(m) => (
          <Tooltip
            as="button"
            type="button"
            class={styles.chip}
            classList={{ [styles.on]: isActive(m), [styles.off]: !m.state.usable }}
            style={m.style}
            // A member with nothing on disk is not somewhere to switch to, and
            // it wears its state rather than looking merely unselected.
            disabled={!m.state.usable}
            aria-pressed={isActive(m)}
            aria-label={nameOf(m)}
            label={nameOf(m)}
            data-member={m.member.repoPath}
            onClick={() => switchTo(m)}
          >
            {memberInitials(m.member)}
          </Tooltip>
        )}
      </For>
      <Show when={split().hidden.length}>
        <Dropdown
          class={styles.more}
          aria-label={`${split().hidden.length} more members`}
          items={split().hidden.map((m) => ({
            label: nameOf(m),
            disabled: !m.state.usable,
            onClick: () => switchTo(m),
          }))}
        >
          +{split().hidden.length}
        </Dropdown>
      </Show>
    </div>
  );
}
