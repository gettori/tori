import { For, Show, createMemo } from "solid-js";
import Button from "../../components/Button/Button";
import ContextMenu from "../../components/Menu/ContextMenu";
import type { MenuItem } from "../../components/Menu/rows";
import MemberChip from "../../components/MemberChip/MemberChip";
import type { Feature, Member } from "../../utils/features";
import { tintedMembers, type SpaceTint } from "../../utils/featureMembers";
import styles from "./FeatureItem.module.css";

export type { SpaceTint };

/** How many member chips a row shows before the rest collapse into `+N`. */
export const CHIP_CAP = 6;

/** One Feature row: the name on one line, then one chip per member in order,
 *  tinted by the Space its repo sits in. A click selects the Feature; Retry on
 *  a failed member is the only other action on the row. */
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
}) {
  const members = createMemo(() => tintedMembers(props.feature, props.spaces));
  const shown = () => members().slice(0, CHIP_CAP);
  const overflow = () => Math.max(0, members().length - CHIP_CAP);
  const retryable = () => members().filter((m) => m.state.action === "retry");

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
                classList={{ [styles.pending]: m.state.label === "Creating" }}
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
