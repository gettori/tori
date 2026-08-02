// One branch-unit's forge story, drawn.
//
// Shared by the sidebar's branch rows and the Pull Requests panel because both
// answer the same question about the same PR, and two renderers is how a row
// and its chip end up disagreeing about what "failing" looks like. Every
// *decision* is still `utils/forgeChip.ts`'s; what lives here is glyphs,
// classes, and whether the thing is a control.

import { Show } from "solid-js";
import {
  GitPullRequest,
  GitPullRequestDraft,
  GitPullRequestClosed,
  GitMerge,
  CircleCheck,
  CircleX,
  CircleDotDashed,
  MessageSquareWarning,
  MessageSquareCheck,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../Icon/Icon";
import type { BadgeTone, ForgeChip, PrChipState } from "../../utils/forgeChip";
import styles from "./ForgeChip.module.css";

// The glyph for a pull-request state. `none` is the branch with no PR: an
// outline of the same shape, so the row reads as "this could have one" rather
// than as a different kind of thing.
function prIcon(state: PrChipState): LucideIcon {
  switch (state) {
    case "draft":
      return GitPullRequestDraft;
    case "merged":
      return GitMerge;
    case "closed":
      return GitPullRequestClosed;
    default:
      return GitPullRequest;
  }
}

// Checks and the review verdict get different glyph families on purpose: both
// can be green at once, and two identical ticks side by side say nothing about
// which of the two passed.
const CHECK_ICON: Record<BadgeTone, LucideIcon> = {
  good: CircleCheck,
  bad: CircleX,
  busy: CircleDotDashed,
};
const REVIEW_ICON: Record<BadgeTone, LucideIcon> = {
  good: MessageSquareCheck,
  bad: MessageSquareWarning,
  busy: CircleDotDashed,
};

export default function ForgeChipView(props: {
  chip: ForgeChip;
  /** Makes the chip a control. Absent leaves it inert, which is what every
   *  state that cannot be acted on needs. */
  onActivate?: () => void;
  label?: string;
}) {
  const pr = () => props.chip.pr;
  // The wrapper draws only when something inside it will. A descriptor whose
  // kinds all render nothing must leave no element behind, so an inert unit
  // cannot be hovered, focused, or clicked into a capability it does not have.
  const anything = () => pr() !== null || props.chip.checks !== null || props.chip.review !== null;

  const body = () => (
    <>
      <Show when={pr()}>
        {(p) => (
          <span
            class={`${styles.forgeItem} ${styles[`pr_${p().state}`]}`}
            title={p().title}
            data-forge-pr={p().state}
          >
            <Icon icon={prIcon(p().state)} />
            <Show when={p().label}>{p().label}</Show>
          </span>
        )}
      </Show>
      <Show when={props.chip.checks}>
        {(c) => (
          <span
            class={`${styles.forgeItem} ${styles[c().tone]}`}
            title={c().title}
            data-forge-checks={c().tone}
          >
            <Icon icon={CHECK_ICON[c().tone]} />
          </span>
        )}
      </Show>
      <Show when={props.chip.review}>
        {(r) => (
          <span
            class={`${styles.forgeItem} ${styles[r().tone]}`}
            title={r().title}
            data-forge-review={r().tone}
          >
            <Icon icon={REVIEW_ICON[r().tone]} />
          </span>
        )}
      </Show>
    </>
  );

  return (
    <Show when={anything()}>
      <Show
        when={props.onActivate}
        fallback={
          <span class={styles.forgeChip} data-forge-state={props.chip.kind}>
            {body()}
          </span>
        }
      >
        <button
          type="button"
          class={styles.forgeChip}
          data-forge-state={props.chip.kind}
          aria-label={props.label}
          // The sidebar row around this is a div with its own onClick, so
          // without this a click on the chip would also select the branch and
          // the panel would open onto whatever that selection changed to.
          onClick={(e) => {
            e.stopPropagation();
            props.onActivate?.();
          }}
        >
          {body()}
        </button>
      </Show>
    </Show>
  );
}
