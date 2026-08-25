import { For, Show, createMemo } from "solid-js";
import Button from "../../components/Button/Button";
import ContextMenu from "../../components/Menu/ContextMenu";
import type { MenuItem } from "../../components/Menu/rows";
import { memberInitials, memberState, type Feature, type Member } from "../../utils/features";
import { spaceHue, spaceHueRgb } from "../../utils/spaceTint";
import styles from "./FeatureItem.module.css";

/** The slice of a Space a chip needs to pick its tint: the name and colour the
 *  hue derives from, and the project paths that say which repo belongs to it. */
export type SpaceTint = {
  name: string;
  color?: string;
  projects: { path: string }[];
};

/** How many member chips a row shows before the rest collapse into `+N`. */
export const CHIP_CAP = 6;

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

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
  /** Right-click rows; none means the row is inert. */
  menu?: MenuItem[];
}) {
  const members = createMemo(() => [...props.feature.members].sort((a, b) => a.order - b.order));
  const shown = () => members().slice(0, CHIP_CAP);
  const overflow = () => Math.max(0, members().length - CHIP_CAP);
  const retryable = () => members().filter((m) => memberState(m.state).action === "retry");

  const spaceOf = (member: Member) =>
    props.spaces.find((g) => g.projects.some((p) => samePath(p.path, member.repoPath)));

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
      <div class={styles.name} data-name title={props.feature.branch}>
        {props.feature.name}
      </div>
      <div class={styles.chips}>
        <For each={shown()}>
          {(m) => {
            const space = () => spaceOf(m);
            const summary = () => memberState(m.state);
            const tint = () => {
              const g = space();
              if (!g) return undefined;
              return {
                "--chip-hue": spaceHue(g.name, g.color),
                "--chip-rgb": spaceHueRgb(g.name, g.color),
              };
            };
            const title = () => {
              const s = summary();
              const where = m.worktreePath ?? m.repoPath;
              return s.reason && s.reason !== "pending"
                ? `${m.displayName}: ${s.label} (${s.reason})`
                : `${m.displayName}: ${s.label}, ${where}`;
            };
            return (
              <span
                class={styles.chip}
                classList={{
                  [styles.neutral]: !space(),
                  [styles.pending]: summary().label === "Creating",
                }}
                style={tint()}
                title={title()}
                data-chip={m.repoPath}
                data-state={m.state.kind}
              >
                {memberInitials(m)}
                <Show when={!summary().usable}>
                  <span
                    class={styles.badge}
                    role="img"
                    aria-label={summary().label}
                    title={summary().reason ?? summary().label}
                  >
                    {badgeGlyph(m)}
                  </span>
                </Show>
              </span>
            );
          }}
        </For>
        <Show when={overflow() > 0}>
          <span
            class={styles.more}
            data-more
            title={members()
              .slice(CHIP_CAP)
              .map((m) => m.displayName)
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
                  props.onRetry(m);
                }}
              >
                Retry {m.displayName}
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
