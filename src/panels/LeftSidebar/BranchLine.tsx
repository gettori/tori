import { Show, createMemo } from "solid-js";
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  CircleCheck,
  CircleDotDashed,
  CircleSlash,
  CircleX,
  FileDiff,
  MessageSquare,
  Eye,
  SquareStack,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import TooltipLines from "../../components/Tooltip/TooltipLines";
import { compactAge, compactAgo } from "../../utils/compactAge";
import { forgeBadges, ranChecks, type BadgeTone, type PrChipState } from "../../utils/forgeChip";
import { prTone, releaseShows, type PrTone, type UnitStatus } from "../../utils/forgeTypes";
import type { BaseSync } from "../../utils/gitActions";
import type { SessionUsage } from "../../utils/chatUsageStore";
import { spendView } from "../../utils/spend";
import { operationChip, type Operation } from "../../utils/worktreeOperation";
import type { BranchLineItem, BranchLineMode } from "../Settings/settingsStore";
import styles from "./BranchLine.module.css";

const CHECK_ICON: Record<BadgeTone, LucideIcon> = {
  good: CircleCheck,
  bad: CircleX,
  busy: CircleDotDashed,
};

const TONE_SAYS: Record<PrTone, string> = {
  asked: "Your review is requested",
  changes: "Changes requested",
  conflict: "",
  approved: "Approved",
  quiet: "",
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
 * **It draws only when there is a pull request, a diff or recorded spend**, and
 * that is the whole design.
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
export type BranchLineProps = {
  status: UnitStatus | null;
  /** The base the branch is measured against, whose `stat` is the diff a pull
   *  request of it shows. */
  base?: BaseSync | null;
  watched?: boolean;
  /** Whether the viewer's review is requested on it, a re-request included. */
  reviewAsked?: boolean;
  /** The branch is the repo's default, so its pull request is a release to
   *  another long-lived branch rather than a feature landing. */
  release?: boolean;
  branchSpend?: SessionUsage | null;
  operation?: Operation | null;
  /** The tooltip tells the whole story whatever this hides. */
  show?: { mode: BranchLineMode; items: Record<BranchLineItem, boolean> };
};

function shownPr(props: BranchLineProps) {
  const st = props.status;
  if (!st?.pullRequest) return null;
  return props.release && !releaseShows(st, Date.now() / 1000) ? null : st.pullRequest;
}

function shownStat(props: BranchLineProps) {
  const s = props.base?.stat;
  return s && s.files > 0 ? s : null;
}

/** The facts the line draws for these props. A row with none and no running
 *  operation has no second line. */
export function drawnFacts(props: BranchLineProps): Set<BranchLineItem> {
  const s = props.show;
  const lit = (item: BranchLineItem) =>
    !s || (s.mode === "full" ? s.items[item] : s.mode === "pr" && (item === "pr" || item === "stack"));
  const out = new Set<BranchLineItem>();
  const add = (item: BranchLineItem, has: unknown) => has && lit(item) && out.add(item);
  const p = shownPr(props);
  if (p) {
    const checks = forgeBadges(props.status).checks;
    const finishedAt = p.state === "merged" ? p.mergedAt : p.closedAt;
    add("pr", true);
    add("stack", p.stack);
    add("watched", props.watched);
    add("checks", checks);
    add("skipped", (checks?.tone === "good" || checks?.tone === "bad") && props.status!.checks.skipped > 0);
    add("age", !Number.isNaN(Date.parse((p.state === "open" ? p.createdAt : finishedAt) ?? "")));
    add("comments", p.comments > 0);
  }
  const stat = shownStat(props);
  add("diff", stat);
  add("files", stat);
  add("spend", spendView(props.branchSpend, "this branch"));
  return out;
}

export default function BranchLine(props: BranchLineProps) {
  const drawn = createMemo(() => drawnFacts(props));
  const shows = (item: BranchLineItem) => drawn().has(item);
  const op = () => (props.operation ? operationChip(props.operation) : null);
  const pr = () => shownPr(props);
  const stat = () => shownStat(props);
  const spent = () => spendView(props.branchSpend, "this branch");
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
  const conflicts = () => props.base?.conflicts ?? [];
  const tone = () =>
    props.status ? prTone(props.status, props.reviewAsked === true, conflicts().length > 0, props.release) : "quiet";
  const numberClass = () => {
    if (state() === "open") return `tone_${tone()}`;
    return props.release ? "pr_closed" : `pr_${state()}`;
  };
  const checks = () => props.status!.checks;
  const ran = () => ranChecks(checks());
  const passed = () => ran() - checks().failing;

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
    const o = op();
    if (o) return [o.title];
    if (p) return [`#${p.number} ${p.title}`];
    if (stat()) return [diffLine()];
    return spent() ? [spent()!.says] : [];
  };
  const conflictStory = () => {
    const files = conflicts();
    if (!files.length || pr()?.state !== "open") return [];
    const CAP = 3;
    return [
      `${props.base!.name} has moved on, and ${plural(files.length, "file")} would conflict when you catch up`,
      ...files.slice(0, CAP),
      files.length > CAP ? `+${files.length - CAP} more files` : "",
    ];
  };
  const storyRest = () => {
    const p = pr();
    if (op()) {
      if (p) return [`#${p.number} ${p.title}`];
      return [stat() ? diffLine() : "", spent()?.says ?? ""].filter(Boolean);
    }
    if (!p) return stat() && spent() ? [spent()!.says] : [];
    const b = badges();
    return [
      stat() ? diffLine() : "",
      spent()?.says ?? "",
      openedAt() !== null ? `${p.author} opened ${compactAgo(openedAt()!)}` : `Opened by ${p.author}`,
      endedAt() !== null ? `${pr()!.state === "merged" ? "Merged" : "Closed"} ${compactAgo(endedAt()!)}` : "",
      p.stack ? `Layer ${p.stack.position} of ${p.stack.size} in a stack, targets ${p.stack.baseRef}` : "",
      TONE_SAYS[tone()] || b.review?.title,
      b.checks?.title,
      p.comments ? `${p.comments} comment${p.comments === 1 ? "" : "s"}` : "",
      props.watched ? "A chat is watching it" : "",
      ...conflictStory(),
    ].filter((line): line is string => Boolean(line));
  };

  // Ordered by what a reader most wants, because a fact that does not fit
  // wraps whole to the next line (see `.items`): the number and its standing,
  // the size of the change, and last the age and the comment count.
  const standing = (p: () => NonNullable<UnitStatus["pullRequest"]>) => (
    <>
      <Show when={shows("pr")}>
        <span
          class={`${styles.item} ${styles[numberClass()]}`}
          data-pr-state={state()}
          data-pr-tone={state() === "open" ? tone() : undefined}
          data-pr-release={props.release ? p().baseRef : undefined}
        >
          <Icon icon={props.release ? GitPullRequestArrow : prIcon(state())} />
          {props.release ? `-> ${p().baseRef} #${p().number}` : `#${p().number}`}
        </span>
      </Show>

      <Show when={shows("stack") && p().stack}>
        {(st) => (
          <span class={styles.item} data-pr-stack={`${st().position}/${st().size}`}>
            <Icon icon={SquareStack} />
            {`${st().position}/${st().size}`}
          </span>
        )}
      </Show>

      <Show when={shows("watched")}>
        <span class={styles.item} data-pr-watched>
          <Icon icon={Eye} />
        </span>
      </Show>

      <Show when={shows("checks") && badges().checks}>
        {(c) => (
          <span class={`${styles.item} ${styles[c().tone]}`} data-pr-checks={c().tone}>
            <Icon icon={CHECK_ICON[c().tone]} />
            {/* Running checks have no score yet, so the glyph stands alone
                rather than claiming a total that is still moving. */}
            <Show when={c().tone !== "busy" && ran() > 0}>{`${passed()}/${ran()}`}</Show>
          </span>
        )}
      </Show>

      <Show when={shows("skipped") ? checks().skipped : 0}>
        <span class={`${styles.item} ${styles.skipped}`} data-pr-skipped={checks().skipped}>
          <Icon icon={CircleSlash} />
          {checks().skipped}
        </span>
      </Show>
    </>
  );

  const size = (s: () => NonNullable<BaseSync["stat"]>) => (
    <>
      <Show when={shows("diff")}>
        <span class={styles.item} data-diff-lines>
          <span class={styles.good}>{`+${s().insertions}`}</span>/<span class={styles.bad}>{`-${s().deletions}`}</span>
        </span>
      </Show>
      <Show when={shows("files")}>
        <span class={styles.item} data-diff-files={s().files}>
          <Icon icon={FileDiff} />
          {s().files}
        </span>
      </Show>
    </>
  );

  const history = (p: () => NonNullable<UnitStatus["pullRequest"]>) => (
    <>
      <Show when={shows("age") && (ended() ?? age())}>{(a) => <span class={styles.item}>{a()}</span>}</Show>

      <Show when={shows("comments")}>
        <span class={styles.item} data-pr-comments={p().comments}>
          <Icon icon={MessageSquare} />
          {p().comments}
        </span>
      </Show>
    </>
  );

  return (
    <Show when={op() || drawn().size > 0}>
      {
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
          <span class={styles.items}>
            <Show when={op()}>
              {(o) => (
                <>
                  <span
                    class={`${styles.item} ${o().conflicted ? styles.bad : styles.busy}`}
                    data-operation={props.operation!.kind}
                  >
                    {o().text}
                  </span>
                  <Show when={o().files}>
                    {(files) => (
                      <span class={`${styles.item} ${styles.bad}`} data-operation-files>
                        {files()}
                      </span>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show when={pr()}>{(p) => standing(p)}</Show>
            <Show when={stat()}>{(s) => size(s)}</Show>
            <Show when={shows("spend") && spent()}>
              {(v) => (
                <span class={styles.item} data-spend>
                  {v().text}
                </span>
              )}
            </Show>
            <Show when={pr()}>{(p) => history(p)}</Show>
          </span>
        </Tooltip>
      }
    </Show>
  );
}
