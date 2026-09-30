import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { ChevronRight } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import ContextMenu from "../../components/Menu/ContextMenu";
import type { MenuItem } from "../../components/Menu/rows";
import MemberChip from "../../components/MemberChip/MemberChip";
import { REPAIR_LABEL, isReference, type Topic, type Member, type RepairAction } from "../../utils/topics";
import { CHIP_CAP, tintedMembers, type SpaceTint } from "../../utils/topicMembers";
import { markTitle, memberSyncState, rollupSync, syncMarks, type FinishedPr } from "../../utils/branchSync";
import SyncMarks from "../../components/SyncMarks/SyncMarks";
import type { BranchSync } from "../../utils/gitActions";
import { createDragReorder } from "../../utils/dragReorder";
import type { Rollup } from "../../utils/sessionStatus";
import StatusBubble from "./StatusBubble";
import PrLine from "./PrLine";
import type { UnitStatus } from "../../utils/forgeTypes";
import styles from "./TopicItem.module.css";

export type { SpaceTint };

/** Re-exported for this row's own test, which reads the cap it draws to. The
 *  constant lives beside the member rules now, because the right panel's chip
 *  row caps to the same number. */
export { CHIP_CAP };

/** One Topic row: the name on one line, then one chip per member in order,
 *  tinted by the Space its repo sits in. A click selects the Topic; the
 *  disclosure opens the full member list, where the per-member actions live. */
export default function TopicItem(props: {
  topic: Topic;
  spaces: SpaceTint[];
  /** The repair a broken member's row offers. Which one is `memberState`'s
   *  call, not this row's: the same three actions drive the Omnibox and the
   *  toast, and a fourth reading of the state is a fourth chance to disagree. */
  onRepair: (member: Member, action: RepairAction) => void;
  onSelect?: (topic: Topic) => void;
  /** The Topic the shell is showing. */
  active?: boolean;
  /** Right-click rows; none means the row is inert. */
  menu?: MenuItem[];
  /** Right-click rows for one member row; none leaves the rows inert. */
  memberMenu?: (member: Member) => MenuItem[];
  /** Where one member's branch stands. Injected rather than read from the sync
   *  store here, so the key rule (a member's worktree plus the Topic's branch)
   *  stays at the one call site that already knows both. Absent draws no state
   *  at all, which is what a story or a Topic nothing has answered for wants. */
  memberSync?: (member: Member) => BranchSync | null;
  memberFinished?: (member: Member) => FinishedPr | null;
  /** A member's pull request on the Topic branch, when the poller has one. */
  memberPr?: (member: Member) => UnitStatus | null;
  status?: () => Rollup | null;
  /** The members' repo paths in the order a drag or a Move landed on. */
  onReorder?: (repoPaths: string[]) => void;
  /** Controlled disclosure. A list that replaces the record on every rename or
   *  reorder re-creates this row with it, so an open list kept here would shut
   *  itself on the very actions it exists to offer. Uncontrolled without
   *  `onExpand`, which is what the stories and the standalone tests use. */
  expanded?: boolean;
  onExpand?: (open: boolean) => void;
}) {
  const [own, setOwn] = createSignal(false);
  const open = () => (props.onExpand ? !!props.expanded : own());
  const toggle = () => (props.onExpand ? props.onExpand(!open()) : setOwn((v) => !v));
  const listId = createUniqueId();
  const members = createMemo(() => tintedMembers(props.topic, props.spaces));
  const shown = () => members().slice(0, CHIP_CAP);
  const overflow = () => Math.max(0, members().length - CHIP_CAP);

  const syncOf = (m: Member) => props.memberSync?.(m) ?? null;
  const finishedOf = (m: Member) => props.memberFinished?.(m) ?? null;
  const prOf = (m: Member) => props.memberPr?.(m) ?? null;
  const stateOf = (m: Member) => memberSyncState({ sync: syncOf(m), finished: finishedOf(m), pr: prOf(m) });
  const referenceWarning = (m: Member): string | null => {
    if (!isReference(m) || m.state.kind !== "present") return null;
    const c = m.checkout;
    if (c?.branch && c.defaultBranch && c.branch !== c.defaultBranch) return `On ${c.branch}, not ${c.defaultBranch}`;
    return syncOf(m)?.dirty ? "Has uncommitted changes" : null;
  };
  const stateLabel = (m: Member, label: string) =>
    isReference(m) && m.state.kind === "present" ? "Reference" : label;
  // Over every member, not the six that fit: a Topic speaks for all of them,
  // and the conflict hiding behind `+3` is the one worth knowing about.
  const rollup = createMemo(() =>
    rollupSync(
      members().map((m) => ({ label: m.label, sync: syncOf(m.member), finished: finishedOf(m.member), pr: prOf(m.member) })),
    ),
  );

  const drag = createDragReorder({
    keys: () => members().map((m) => m.member.repoPath),
    onCommit: (repoPaths) => props.onReorder?.(repoPaths),
  });

  return (
    <ContextMenu
      as="li"
      class={styles.item}
      classList={{ [styles.active]: !!props.active }}
      items={props.menu}
      disabled={!props.menu}
      data-topic={props.topic.id}
      aria-current={props.active ? "true" : undefined}
      onClick={() => props.onSelect?.(props.topic)}
    >
      <div class={styles.head}>
        <button
          type="button"
          class={styles.disclosure}
          aria-expanded={open()}
          // Only while the list exists: a dangling `aria-controls` names an
          // element the assistive tech is then asked to go and not find.
          aria-controls={open() ? listId : undefined}
          aria-label={`${open() ? "Hide" : "Show"} members of ${props.topic.name}`}
          data-disclosure
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <Icon icon={ChevronRight} class={styles.caret} classList={{ [styles.caretOpen]: open() }} />
        </button>
        <div class={styles.name} data-name title={props.topic.branch}>
          {props.topic.name}
        </div>
        {/* At the trailing end of line one, so a Topic with news is exactly as
            tall as one without. The loudest member's own glyphs, not a summary
            of them: the tooltip is where "which member" belongs. */}
        <StatusBubble rollup={() => props.status?.() ?? null} />
        <Show when={rollup().state.level !== "none"}>
          <span class={styles.rollup} data-topic-sync={rollup().state.level}>
            <SyncMarks marks={rollup().marks} label={rollup().state.detail} />
          </span>
        </Show>
      </div>
      <Show
        when={open()}
        fallback={
          <div class={styles.chips}>
            <For each={shown()}>
              {(m) => {
                // Memoized, not bare accessors: the chip reads each of them in
                // its title, its dot and that dot's tone, and `memberSyncState`
                // rebuilds its verdict on every read.
                const sync = createMemo(() => stateOf(m.member));
                const dirty = createMemo(() => !!syncOf(m.member)?.dirty);
                const title = () => {
                  const s = m.state;
                  const branch = [sync().detail, dirty() ? "Uncommitted changes" : ""].filter(Boolean);
                  const label = stateLabel(m.member, s.label);
                  const head =
                    s.reason && s.reason !== "pending"
                      ? `${m.label}: ${label} (${s.reason})`
                      : `${m.label}: ${label}, ${m.key}`;
                  return [head, referenceWarning(m.member) ?? "", ...branch].filter(Boolean).join("\n");
                };
                return (
                  <MemberChip
                    icon={m.icon}
                    chipStyle={m.style}
                    reference={isReference(m.member)}
                    size="md"
                    // Never `decorative` here: the badge below is the only spoken
                    // account of a member whose worktree is gone.
                    title={title()}
                    data-chip={m.member.repoPath}
                    data-state={m.member.state.kind}
                  >
                    <Show when={!m.state.usable}>
                      <span
                        class={styles.badge}
                        role="img"
                        aria-label={m.state.label}
                        title={m.state.reason ?? m.state.label}
                      >
                        {badgeGlyph(m.member)}
                      </span>
                    </Show>
                    {/* Two corners, because the two are independent: a member
                        can be mid-edit with nothing else to report, and a
                        conflicted one need not have touched a file. */}
                    <Show when={sync().level !== "none"}>
                      <span class={`${styles.syncDot} ${styles[sync().tone]}`} data-member-sync={sync().level} />
                    </Show>
                    <Show when={dirty()}>
                      <span class={styles.dirtyDot} data-member-dirty />
                    </Show>
                  </MemberChip>
                );
              }}
            </For>
            <Show when={overflow() > 0}>
              <span
                class={styles.more}
                data-more
                title={members()
                  .slice(CHIP_CAP)
                  .map((m) => m.label)
                  .join(", ")}
              >
                +{overflow()}
              </span>
            </Show>
          </div>
        }
      >
        <ul class={styles.members} id={listId}>
          <For each={members()}>
            {(m) => (
              <ContextMenu
                as="li"
                class={styles.member}
                classList={{
                  [styles.memberDragging]: drag.dragging() === m.member.repoPath,
                  [styles.memberOver]: drag.over() === m.member.repoPath,
                }}
                items={props.memberMenu?.(m.member)}
                disabled={!props.memberMenu}
                data-member={m.member.repoPath}
                data-state={m.member.state.kind}
                {...drag.rowProps(m.member.repoPath)}
              >
                {/* Decorative: the name beside it is the spoken account here,
                    unlike the collapsed chip, which is on its own. */}
                <MemberChip icon={m.icon} chipStyle={m.style} reference={isReference(m.member)} size="md" decorative />
                <span class={styles.memberName}>{m.label}</span>
                <SyncMarks
                  marks={syncMarks(syncOf(m.member), finishedOf(m.member))}
                  label={markTitle(syncMarks(syncOf(m.member), finishedOf(m.member)))}
                />
                {/* Only when something is wrong: a working member is the norm,
                    and a reference already wears its lock. */}
                <Show when={!m.state.usable}>
                  <span class={styles.memberState} data-member-state>
                    {m.state.label}
                  </span>
                </Show>
                <Show when={referenceWarning(m.member)}>
                  {(warning) => (
                    <span class={styles.memberWarning} data-member-warning>
                      {warning()}
                    </span>
                  )}
                </Show>
                {/* On the row rather than in an actions strip below the chips:
                    the strip named the member in the button and still left the
                    seventh one, hidden behind `+N`, with nothing to press. */}
                <Show when={m.state.action}>
                  {(action) => (
                    <Button
                      size="xs"
                      variant="ghost"
                      class={styles.repair}
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation();
                        props.onRepair(m.member, action());
                      }}
                    >
                      {REPAIR_LABEL[action()]} {m.label}
                    </Button>
                  )}
                </Show>
                <Show when={prOf(m.member)?.pullRequest ? prOf(m.member) : null}>
                  {(status) => (
                    <div class={styles.memberPr} data-member-pr>
                      <PrLine status={status()} />
                    </div>
                  )}
                </Show>
              </ContextMenu>
            )}
          </For>
        </ul>
      </Show>
    </ContextMenu>
  );
}

function badgeGlyph(member: Member): string {
  switch (member.state.kind) {
    case "worktree-missing":
    case "checkout-missing":
      return "!";
    case "repo-missing":
      return "?";
    case "failed":
      return member.state.reason === "pending" ? "..." : "x";
    default:
      return "";
  }
}
