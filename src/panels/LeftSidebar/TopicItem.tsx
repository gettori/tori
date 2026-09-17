import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { ChevronRight } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import ContextMenu from "../../components/Menu/ContextMenu";
import type { MenuItem } from "../../components/Menu/rows";
import MemberChip from "../../components/MemberChip/MemberChip";
import { REPAIR_LABEL, type Topic, type Member, type RepairAction } from "../../utils/topics";
import { CHIP_CAP, tintedMembers, type SpaceTint } from "../../utils/topicMembers";
import { createDragReorder } from "../../utils/dragReorder";
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
      </div>
      <Show
        when={open()}
        fallback={
          <div class={styles.chips}>
            <For each={shown()}>
              {(m) => {
                const title = () => {
                  const s = m.state;
                  return s.reason && s.reason !== "pending"
                    ? `${m.label}: ${s.label} (${s.reason})`
                    : `${m.label}: ${s.label}, ${m.key}`;
                };
                return (
                  <MemberChip
                    member={m.member}
                    chipStyle={m.style}
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
                <MemberChip member={m.member} chipStyle={m.style} size="md" decorative />
                <span class={styles.memberName}>{m.label}</span>
                <span class={styles.memberState} data-member-state>
                  {m.state.label}
                </span>
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
      return "!";
    case "repo-missing":
      return "?";
    case "failed":
      return member.state.reason === "pending" ? "..." : "x";
    default:
      return "";
  }
}
