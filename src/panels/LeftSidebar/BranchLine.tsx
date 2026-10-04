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
import TooltipLines from "../../components/Tooltip/TooltipLines";
import { compactAge, compactAgo } from "../../utils/compactAge";
import { forgeBadges, type BadgeTone, type PrChipState } from "../../utils/forgeChip";
import type { UnitStatus } from "../../utils/forgeTypes";
import type { BaseSync } from "../../utils/gitActions";
import styles from "./BranchLine.module.css";

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
 * first line has never had the width for, then the size of the branch's diff.
 *
 * **It draws only when there is a pull request or a diff**, and that is the
 * whole design.
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
export default function BranchLine(props: {
  status: UnitStatus | null;
  /** The base the branch is measured against, whose `stat` is the diff a pull
   *  request of it shows. */
  base?: BaseSync | null;
}) {
  const pr = () => props.status?.pullRequest ?? null;
  const stat = () => {
    const s = props.base?.stat;
    return s && s.files > 0 ? s : null;
  };
  const badges = () => forgeBadges(props.status);
  // RFC 3339 on the wire, epoch seconds here, and nothing at all if the host
  // sent something unparseable: a row that prints `NaNd` is worse than a row
  // that prints no age.
  const openedAt = () => {
    const at = Date.parse(pr()?.createdAt ?? "");
    return Number.isNaN(at) ? null : at / 1000;
  };
  // Bare on the line, where it is one fact in a run, and with an "ago" suffix
  // in the tooltip, where it is part of a sentence.
  const age = () => {
    const at = openedAt();
    return at === null ? null : compactAge(at);
  };
  // A finished pull request's news is when it finished, not when it opened.
  const endedAt = () => {
    const p = pr();
    if (!p || p.state === "open") return null;
    const at = Date.parse((p.state === "merged" ? p.mergedAt : p.closedAt) ?? "");
    return Number.isNaN(at) ? null : at / 1000;
  };
  const ended = () => {
    const at = endedAt();
    return at === null ? null : `${pr()!.state} ${compactAge(at)}`;
  };
  const state = (): PrChipState => {
    const p = pr();
    if (!p) return "none";
    return p.state === "open" ? (p.isDraft ? "draft" : "open") : p.state;
  };
  const checks = () => props.status!.checks;
  const passed = () => checks().total - checks().failing;

  // One hover target for the whole line rather than one per fact, the same
  // call `SyncMarks` makes about its run and for the same reasons: these are
  // 12px glyphs, none of them is focusable, and the reader wants the pull
  // request's standing in one place rather than five hovers to assemble it.
  // It is also where the words the rail has no width for go to live.
  // The title leads, because it is the one thing the line itself cannot show:
  // `#428` is on screen already and the sentence behind it is not. Everything
  // after it is the same facts the glyphs carry, spelled out.
  const diffLine = () => {
    const s = stat()!;
    return `${plural(s.files, "file")} changed against ${props.base!.name}, +${s.insertions} -${s.deletions}`;
  };
  const storyLead = () => {
    const p = pr();
    if (p) return [`#${p.number} ${p.title}`];
    return stat() ? [diffLine()] : [];
  };
  const storyRest = () => {
    const p = pr();
    if (!p) return [];
    const b = badges();
    return [
      stat() ? diffLine() : "",
      openedAt() !== null ? `${p.author} opened ${compactAgo(openedAt()!)}` : `Opened by ${p.author}`,
      endedAt() !== null ? `${pr()!.state === "merged" ? "Merged" : "Closed"} ${compactAgo(endedAt()!)}` : "",
      b.review?.title,
      b.checks?.title,
      p.comments ? `${p.comments} comment${p.comments === 1 ? "" : "s"}` : "",
    ].filter((line): line is string => Boolean(line));
  };

  const facts = (p: () => NonNullable<UnitStatus["pullRequest"]>) => (
    <>
      <span class={`${styles.item} ${styles[`pr_${state()}`]}`} data-pr-state={state()}>
        <Icon icon={prIcon(state())} />
        {`#${p().number}`}
      </span>

      <Show when={ended() ?? age()}>{(a) => <span class={styles.item}>{a()}</span>}</Show>

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

  const diff = (s: () => NonNullable<BaseSync["stat"]>) => (
    <>
      <span class={styles.item} data-diff-files={s().files}>
        {plural(s().files, "file")}
      </span>
      <span class={styles.item} data-diff-lines>
        <span class={styles.good}>{`+${s().insertions}`}</span>/<span class={styles.bad}>{`-${s().deletions}`}</span>
      </span>
    </>
  );

  return (
    <Show when={pr() || stat()}>
      {(
        // A span, not a button. The line reports; it is not a way in. The
        // Pull Requests panel is reached from the command palette and from
        // the editor's own right-panel tabs, so a control per branch row here
        // would be a third door into one panel and a tab stop on every row of
        // a list the keyboard cannot otherwise walk.
        <Tooltip<HTMLSpanElement>
          as="span"
          class={styles.line}
          data-pr-line={pr() ? "" : undefined}
          label={<TooltipLines lead={storyLead()} rest={storyRest()} />}
        >
          <Show when={pr()}>{(p) => facts(p)}</Show>
          <Show when={stat()}>{(s) => diff(s)}</Show>
        </Tooltip>
      )}
    </Show>
  );
}
