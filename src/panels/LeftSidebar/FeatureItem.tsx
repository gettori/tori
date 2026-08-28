import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { ChevronRight } from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import ContextMenu from "../../components/Menu/ContextMenu";
import type { MenuItem } from "../../components/Menu/rows";
import MemberChip from "../../components/MemberChip/MemberChip";
import type { Feature, Member } from "../../utils/features";
import { tintedMembers, type SpaceTint } from "../../utils/featureMembers";
import { createDragReorder } from "../../utils/dragReorder";
import styles from "./FeatureItem.module.css";

export type { SpaceTint };

/** How many member chips a *collapsed* row shows before the rest collapse into
 *  `+N`. The expanded list has no cap: a member no chip can reach is a member
 *  whose rename, reorder and repair would be unreachable with it. */
export const CHIP_CAP = 6;

/** One Feature row: the name on one line, then one chip per member in order,
 *  tinted by the Space its repo sits in. A click selects the Feature; the
 *  disclosure opens the full member list, where the per-member actions live. */
export default function FeatureItem(props: {
  feature: Feature;
  spaces: SpaceTint[];
  onRetry: (member: Member) => void;
  onSelect?: (feature: Feature) => void;
  /** The Feature the shell is showing. */
  active?: boolean;
  /** Files touched across this Feature's members. Zero shows nothing: a Feature
   *  nobody has open reads zero, and a clean one has no news either way. */
  changed?: number;
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
  const members = createMemo(() => tintedMembers(props.feature, props.spaces));
  const shown = () => members().slice(0, CHIP_CAP);
  const overflow = () => Math.max(0, members().length - CHIP_CAP);
  const retryable = () => members().filter((m) => m.state.action === "retry");

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
      data-feature={props.feature.id}
      aria-current={props.active ? "true" : undefined}
      onClick={() => props.onSelect?.(props.feature)}
    >
      <div class={styles.head}>
        <button
          type="button"
          class={styles.disclosure}
          aria-expanded={open()}
          // Only while the list exists: a dangling `aria-controls` names an
          // element the assistive tech is then asked to go and not find.
          aria-controls={open() ? listId : undefined}
          aria-label={`${open() ? "Hide" : "Show"} members of ${props.feature.name}`}
          data-disclosure
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <Icon icon={ChevronRight} class={styles.caret} classList={{ [styles.caretOpen]: open() }} />
        </button>
        <div class={styles.name} data-name title={props.feature.branch}>
          {props.feature.name}
        </div>
        <Show when={props.changed}>
          {(n) => (
            <span class={styles.count} data-changed>
              {n()} changed
            </span>
          )}
        </Show>
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
              </ContextMenu>
            )}
          </For>
        </ul>
      </Show>
      <Show when={retryable().length > 0}>
        <div class={styles.actions}>
          <For each={retryable()}>
            {(m) => (
              <Button
                size="xs"
                variant="ghost"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  props.onRetry(m.member);
                }}
              >
                Retry {m.label}
              </Button>
            )}
          </For>
        </div>
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
