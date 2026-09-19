import { Show } from "solid-js";
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  CircleCheck,
  CircleDotDashed,
  CircleX,
  MessageSquare,
  MessageSquareCheck,
  MessageSquareWarning,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { compactAge } from "../../utils/compactAge";
import { forgeBadges, type BadgeTone, type PrChipState } from "../../utils/forgeChip";
import type { UnitStatus } from "../../utils/forgeTypes";
import styles from "./PrLine.module.css";

// The same two families ForgeChip uses, for the same reason: checks and the
// verdict can both be green at once, and two identical ticks say nothing about
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

/**
 * A branch row's second line: its pull request, in the words and numbers the
 * first line has never had the width for.
 *
 * **It draws only when there is a pull request**, and that is the whole design.
 * The chip on line one had to compress "is there a PR, what state, how are the
 * checks, what did review say" into three 13px glyphs, because three glyphs is
 * what a 260px rail leaves once the name has had its share. Given a line of its
 * own, `4/5` can be `4/5`. And because the line is absent when there is no PR,
 * the branch that has none says so by saying nothing, which is what lets the
 * `noPr` marker come off every other row in the column.
 *
 * Every decision here is still `utils/forgeChip.ts`'s: `forgeBadges` derives
 * the two tones, so this and `ForgeChipView` cannot end up disagreeing about
 * what a failing check looks like. What this adds is the counts behind those
 * tones, which the tone alone throws away.
 */
export default function PrLine(props: {
  status: UnitStatus;
  /** Opens the Pull Requests panel onto this branch. The chip on the line
   *  above used to carry this; with the chip gone for a branch that has a PR,
   *  the line is the only thing left that could. Absent leaves it inert. */
  onOpen?: () => void;
  /** What the control announces. Required in spirit whenever `onOpen` is. */
  label?: string;
}) {
  const pr = () => props.status.pullRequest;
  const badges = () => forgeBadges(props.status);
  // RFC 3339 on the wire, epoch seconds here, and nothing at all if the host
  // sent something unparseable: a row that prints `NaNd` is worse than a row
  // that prints no age.
  const age = () => {
    const at = Date.parse(pr()?.createdAt ?? "");
    return Number.isNaN(at) ? null : compactAge(at / 1000);
  };
  const state = (): PrChipState => {
    const p = pr();
    if (!p) return "none";
    return p.state === "open" ? (p.isDraft ? "draft" : "open") : p.state;
  };
  const checks = () => props.status.checks;
  const passed = () => checks().total - checks().failing;

  // One hover target for the whole line rather than one per fact, the same
  // call `SyncMarks` makes about its run and for the same reasons: these are
  // 12px glyphs, none of them is focusable, and the reader wants the pull
  // request's standing in one place rather than five hovers to assemble it.
  // It is also where the words the rail has no width for go to live.
  const story = () => {
    const p = pr();
    if (!p) return "";
    const b = badges();
    return [
      `#${p.number} ${p.title}`,
      age() ? `${p.author} opened ${age()} ago` : `Opened by ${p.author}`,
      b.review?.title,
      b.checks?.title,
      p.comments ? `${p.comments} comment${p.comments === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const facts = (p: () => NonNullable<UnitStatus["pullRequest"]>) => (
    <>
      <span class={`${styles.item} ${styles[`pr_${state()}`]}`} data-pr-state={state()}>
        <Icon icon={prIcon(state())} />
        {`#${p().number}`}
      </span>

      <Show when={age()}>{(a) => <span class={styles.item}>{a()}</span>}</Show>

      <Show when={badges().review}>
        {(r) => (
          <span class={`${styles.item} ${styles[r().tone]}`} data-pr-review={r().tone}>
            <Icon icon={REVIEW_ICON[r().tone]} />
          </span>
        )}
      </Show>

      <Show when={badges().checks}>
        {(c) => (
          <span class={`${styles.item} ${styles[c().tone]}`} data-pr-checks={c().tone}>
            <Icon icon={CHECK_ICON[c().tone]} />
            {/* Running checks have no score yet, so the glyph stands alone
                rather than claiming a total that is still moving. */}
            <Show when={c().tone !== "busy"}>{`${passed()}/${checks().total}`}</Show>
          </span>
        )}
      </Show>

      <Show when={p().comments > 0}>
        <span class={styles.item} data-pr-comments={p().comments}>
          <Icon icon={MessageSquare} />
          {p().comments}
        </span>
      </Show>
    </>
  );

  return (
    <Show when={pr()}>
      {(p) => (
        <Show
          when={props.onOpen}
          fallback={
            <Tooltip<HTMLSpanElement>
              as="span"
              class={styles.prLine}
              data-pr-line
              label={<span class={styles.lines}>{story()}</span>}
            >
              {facts(p)}
            </Tooltip>
          }
        >
          {/* A button rather than a styled span, on the same reasoning
              `ForgeChipView` gives: this is a real capability, and the row
              around it is a div with an onClick, so nothing else here is
              tabbable. `stopPropagation` keeps a click from also selecting the
              branch and moving the panel off what it just opened. */}
          <Tooltip<HTMLButtonElement>
            as="button"
            type="button"
            class={`${styles.prLine} ${styles.control}`}
            data-pr-line
            label={<span class={styles.lines}>{story()}</span>}
            aria-label={props.label}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              props.onOpen?.();
            }}
          >
            {facts(p)}
          </Tooltip>
        </Show>
      )}
    </Show>
  );
}
