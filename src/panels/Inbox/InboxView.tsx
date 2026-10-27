import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePlay,
  CircleX,
  ClipboardCheck,
  Clock,
  GitMerge,
  GitPullRequest,
  Hand,
  Hourglass,
  LoaderCircle,
  MessageSquareText,
  PiggyBank,
  ShieldAlert,
  SquareTerminal,
  UserRoundSearch,
  type LucideIcon,
} from "lucide-solid";
import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import {
  digest,
  digestCount,
  digestTime,
  hideDigest,
  isLimit,
  showDigest,
  verdictLabel,
  type Finished,
} from "../../utils/digest";
import { emitWith, NAVIGATE, type NavTarget } from "../../utils/events";
import { needsYouCount, needsYouEvents, openEvent } from "../../utils/needsYouInbox";
import {
  byProjectNewestFirst,
  eventTime,
  kindLabel,
  type NeedsYouEvent,
  type NeedsYouKind,
} from "../../utils/needsYouSignals";
import { byPlace, type PermissionRow } from "../../utils/permissionGroups";
import {
  allowGroup,
  denyPermission,
  openPermission,
  permissionCount,
  permissionRows,
} from "../../utils/permissionInbox";
import { askedTab, markReviewed, openItem, reviewItems, setAskedTab, type InboxTab } from "../../utils/reviewInbox";
import { opinionLabel, runSecondOpinion, secondOpinionRunning } from "../../utils/secondOpinion";
import { signalLabel, type ReviewItem, type SecondOpinion, type SignalKind } from "../../utils/reviewSignals";
import s from "../Settings/Settings.module.css";
import styles from "./InboxView.module.css";

type Tone = "attention" | "danger" | "success" | "progress" | "muted";

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

const KINDS: Record<NeedsYouKind, { icon: LucideIcon; tone: Tone }> = {
  permission: { icon: Hand, tone: "attention" },
  question: { icon: Hand, tone: "attention" },
  workerQuestion: { icon: Hand, tone: "attention" },
  budget: { icon: PiggyBank, tone: "attention" },
  waiting: { icon: SquareTerminal, tone: "attention" },
  done: { icon: CircleCheck, tone: "muted" },
  pullRequest: { icon: GitPullRequest, tone: "danger" },
  prOpened: { icon: GitPullRequest, tone: "muted" },
  prMerged: { icon: GitMerge, tone: "progress" },
  limitHit: { icon: Hourglass, tone: "attention" },
  limitResumed: { icon: CirclePlay, tone: "muted" },
  denied: { icon: ShieldAlert, tone: "danger" },
};

const TIERS = [
  { label: "High risk", range: "60 and up", min: 60, tone: "danger" },
  { label: "Worth a look", range: "25 to 59", min: 25, tone: "attention" },
  { label: "Small and clean", range: "under 25", min: -Infinity, tone: "muted" },
] as const;

const tierOf = (score: number) => TIERS.find((t) => score >= t.min)!;

const DANGERS: readonly SignalKind[] = ["secretRead", "failed", "deletedTests", "sensitivePath"];
const ATTENTION: readonly SignalKind[] = ["blindEdit", "unverified", "dependencies", "outsideScope", "sharedFile"];

function Meta(props: { parts: JSX.Element[] }) {
  return (
    <span class={styles.meta}>
      <For each={props.parts}>
        {(part, i) => (
          <>
            <Show when={i() > 0}>
              <span class={styles.sep}> · </span>
            </Show>
            {part}
          </>
        )}
      </For>
    </span>
  );
}

// A tier is marked by a square in its tone and keeps a quiet label; any other
// tone colours the label itself.
function GroupHead(props: { label: string; count: number; range?: string; tone?: Tone; mark?: boolean }) {
  return (
    <h3 class={`${s.sectionTitle} ${styles.groupHead}`} data-tone={props.mark ? undefined : props.tone}>
      <Show when={props.mark}>
        <span class={styles.tierMark} data-tone={props.tone} />
      </Show>
      <span>{props.label}</span>
      <span class={styles.groupCount}>{props.count}</span>
      <Show when={props.range}>
        <span class={styles.groupCount}>{props.range}</span>
      </Show>
      <span class={s.sectionRule} />
    </h3>
  );
}

function Group(props: {
  label: string;
  heading?: string;
  count: number;
  tone?: Tone;
  range?: string;
  mark?: boolean;
  waiting?: boolean;
  children: JSX.Element;
}) {
  return (
    <section class={styles.group} aria-label={props.label} data-waiting={props.waiting || undefined}>
      <GroupHead
        label={props.heading ?? props.label}
        count={props.count}
        range={props.range}
        tone={props.tone}
        mark={props.mark}
      />
      <ul class={styles.list}>{props.children}</ul>
    </section>
  );
}

function EventLine(props: {
  icon: LucideIcon;
  tone: Tone;
  name: string;
  meta: JSX.Element[];
  time: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" class={styles.event} onClick={() => props.onOpen()}>
      <span class={styles.kindIcon} data-tone={props.tone}>
        <Icon icon={props.icon} />
      </span>
      <span class={styles.text}>
        <span class={styles.title}>{props.name}</span>
        <Meta parts={props.meta} />
      </span>
      <span class={styles.time}>{props.time}</span>
    </button>
  );
}

function EventRow(props: { event: NeedsYouEvent; withProject?: boolean; time?: string }) {
  const answered = () => props.event.resolvedAt !== null;
  const kind = () => KINDS[props.event.kind];
  return (
    <li classList={{ [styles.answered]: answered() }}>
      <EventLine
        icon={answered() ? Check : kind().icon}
        tone={answered() ? "muted" : kind().tone}
        name={props.event.title || folderName(props.event.folder)}
        meta={[
          ...(props.withProject ? [props.event.project || folderName(props.event.folder)] : []),
          <span data-tone={answered() ? undefined : kind().tone}>{kindLabel(props.event.kind)}</span>,
          ...(answered() ? ["answered"] : []),
        ]}
        time={props.time ?? eventTime(props.event.ts)}
        onOpen={() => openEvent(props.event)}
      />
    </li>
  );
}

function FinishedRow(props: { row: Finished }) {
  const verdict = () => props.row.verdict;
  const look = (): { icon: LucideIcon; tone: Tone } =>
    verdict() === "verified"
      ? { icon: CircleCheck, tone: "success" }
      : verdict() === "failed"
        ? { icon: CircleX, tone: "danger" }
        : { icon: CircleCheck, tone: "muted" };
  return (
    <li>
      <EventLine
        icon={look().icon}
        tone={look().tone}
        name={props.row.title || folderName(props.row.folder)}
        meta={[
          props.row.project || folderName(props.row.folder),
          props.row.turns === 1 ? "1 turn" : `${props.row.turns} turns`,
          ...(props.row.lines
            ? [
                <span>
                  <span data-tone="success">+{props.row.lines.added}</span>{" "}
                  <span data-tone="danger">-{props.row.lines.removed}</span>
                </span>,
              ]
            : []),
          ...(verdict() ? [<span data-tone={look().tone}>{verdictLabel(verdict()!)}</span>] : []),
        ]}
        time={digestTime(props.row.lastTs)}
        onOpen={() => emitWith<NavTarget>(NAVIGATE, { folder: props.row.folder, session: props.row.session })}
      />
    </li>
  );
}

// A pull request row opens its worktree, a limit row the chat that stopped.
function HappenedRow(props: { event: NeedsYouEvent }) {
  const kind = () => KINDS[props.event.kind];
  const target = (): NavTarget =>
    props.event.session ? { folder: props.event.folder, session: props.event.session } : { folder: props.event.folder };
  return (
    <li>
      <EventLine
        icon={kind().icon}
        tone={kind().tone}
        name={props.event.title || folderName(props.event.folder)}
        meta={[
          props.event.project || folderName(props.event.folder),
          <span data-tone={kind().tone}>{kindLabel(props.event.kind)}</span>,
        ]}
        time={digestTime(props.event.ts)}
        onOpen={() => emitWith<NavTarget>(NAVIGATE, target())}
      />
    </li>
  );
}

function Empty(props: { text: string; onReview?: () => void }) {
  return (
    <div class={styles.empty}>
      <p>{props.text}</p>
      <Show when={props.onReview && reviewItems().length > 0}>
        <button type="button" class={styles.link} onClick={() => props.onReview?.()}>
          Open Review
          <Icon icon={ArrowRight} />
        </button>
      </Show>
    </div>
  );
}

function SinceList(props: { onReview: () => void }) {
  onMount(showDigest);
  onCleanup(hideDigest);
  const happened = () => digest()?.happened ?? [];
  return (
    <Show
      when={digestCount(digest())}
      fallback={
        <Empty
          text="Nothing finished since you last looked, and nothing is waiting on you."
          onReview={props.onReview}
        />
      }
    >
      <Show when={digest()?.waiting.length}>
        <Group label="Waiting on you" count={digest()!.waiting.length} tone="attention" waiting>
          <For each={digest()!.waiting}>
            {(event) => <EventRow event={event} withProject time={digestTime(event.ts)} />}
          </For>
        </Group>
      </Show>
      <Show when={digest()?.finished.length}>
        <Group
          label="Finished"
          heading={`Finished since ${digestTime(digest()!.since)}`}
          count={digest()!.finished.length}
        >
          <For each={digest()!.finished}>{(row) => <FinishedRow row={row} />}</For>
        </Group>
      </Show>
      <Show when={happened().filter((e) => !isLimit(e)).length}>
        <Group label="Pull requests" count={happened().filter((e) => !isLimit(e)).length}>
          <For each={happened().filter((e) => !isLimit(e))}>{(event) => <HappenedRow event={event} />}</For>
        </Group>
      </Show>
      <Show when={happened().filter(isLimit).length}>
        <Group label="Usage limits" count={happened().filter(isLimit).length}>
          <For each={happened().filter(isLimit)}>{(event) => <HappenedRow event={event} />}</For>
        </Group>
      </Show>
    </Show>
  );
}

function NeedsYouList(props: { onReview: () => void }) {
  return (
    <Show
      when={needsYouEvents().length}
      fallback={<Empty text="Nothing has needed you in the last day." onReview={props.onReview} />}
    >
      <For each={byProjectNewestFirst(needsYouEvents())}>
        {(group) => (
          <Group label={group.project || "No project"} count={group.events.length}>
            <For each={group.events}>{(event) => <EventRow event={event} />}</For>
          </Group>
        )}
      </For>
    </Show>
  );
}

const agentName = (agent: string) => agent.charAt(0).toUpperCase() + agent.slice(1);

function PermissionPromptRow(props: {
  row: PermissionRow;
  onDeny: (row: PermissionRow) => void;
  onOpen: (row: PermissionRow) => void;
}) {
  return (
    <li class={styles.prompt}>
      <EventLine
        icon={Hand}
        tone="attention"
        name={folderName(props.row.folder)}
        meta={[props.row.tool]}
        time=""
        onOpen={() => props.onOpen(props.row)}
      />
      <IconButton
        size="sm"
        icon={<Icon icon={CircleX} />}
        aria-label={`Deny in ${folderName(props.row.folder)}`}
        tooltip="Deny"
        tooltipPlacement="top"
        onClick={() => props.onDeny(props.row)}
      />
    </li>
  );
}

export function PermissionList(props: {
  rows: PermissionRow[];
  onAllow?: (rows: PermissionRow[]) => void;
  onDeny?: (row: PermissionRow) => void;
  onOpen?: (row: PermissionRow) => void;
}) {
  const allow = (rows: PermissionRow[]) => (props.onAllow ?? allowGroup)(rows);
  const deny = (row: PermissionRow) => (props.onDeny ?? denyPermission)(row);
  const open = (row: PermissionRow) => (props.onOpen ?? openPermission)(row);
  return (
    <Show when={props.rows.length} fallback={<Empty text="No worker is waiting on a permission." />}>
      <For each={byPlace(props.rows)}>
        {(place) => (
          <Group
            label={place.project ? folderName(place.place) : `Other: ${folderName(place.place)}`}
            count={place.commands.reduce((n, c) => n + c.rows.length, 0)}
          >
            <For each={place.commands}>
              {(command) => {
                const first = () => command.rows[0];
                const count = () => command.rows.length;
                return (
                  <li class={styles.command}>
                    <div class={styles.commandHead}>
                      <span class={styles.text}>
                        <code class={styles.commandText}>{first().action ?? first().tool}</code>
                        <Meta
                          parts={[
                            agentName(first().agent),
                            first().tool,
                            `${count()} waiting`,
                            ...(first().rule
                              ? [
                                  <span data-tone="attention">{`${agentName(first().agent)} will remember ${first().rule}`}</span>,
                                ]
                              : []),
                          ]}
                        />
                      </span>
                      <Button size="sm" variant="primary" onClick={() => allow(command.rows)}>
                        {count() === 1 ? "Always allow" : `Always allow for all ${count()}`}
                      </Button>
                    </div>
                    <ul class={styles.list}>
                      <For each={command.rows}>
                        {(row) => <PermissionPromptRow row={row} onDeny={deny} onOpen={open} />}
                      </For>
                    </ul>
                  </li>
                );
              }}
            </For>
          </Group>
        )}
      </For>
    </Show>
  );
}

function opinionLook(o: SecondOpinion): { icon: LucideIcon; tone: Tone | "brand" } {
  if (o.state === "running") return { icon: LoaderCircle, tone: "progress" };
  if (o.state === "failed") return { icon: CircleAlert, tone: "danger" };
  return o.open ? { icon: MessageSquareText, tone: "brand" } : { icon: CircleCheck, tone: "muted" };
}

function ReviewRow(props: { item: ReviewItem }) {
  const tier = () => tierOf(props.item.score);
  const title = () => props.item.title || props.item.unit.id.slice(0, 8);
  const lines = () => props.item.signals.find((sig) => sig.kind === "lines");
  const dangers = () => props.item.signals.filter((sig) => DANGERS.includes(sig.kind));
  const others = () => props.item.signals.filter((sig) => sig.kind !== "lines" && !DANGERS.includes(sig.kind));
  const opinionRunning = () =>
    props.item.secondOpinion?.state === "running" || secondOpinionRunning(props.item.unit.id);
  const [marking, setMarking] = createSignal(false);
  const mark = async () => {
    setMarking(true);
    try {
      await markReviewed(props.item);
    } finally {
      setMarking(false);
    }
  };
  return (
    <li class={styles.review} data-tier={tier().tone}>
      <button
        type="button"
        class={styles.reviewOpen}
        aria-label={`Risk ${props.item.score}, ${tier().label}. ${title()}`}
        onClick={() => openItem(props.item)}
      >
        <span class={styles.score}>
          <span class={styles.scoreNum}>{props.item.score}</span>
          <span class={styles.bar}>
            <span style={{ width: `${Math.min(props.item.score, 100)}%` }} />
          </span>
        </span>
        <span class={styles.text}>
          <span class={styles.titleLine}>
            <span class={styles.reviewTitle}>{title()}</span>
            <Show when={props.item.running}>
              <span class={styles.working}>
                <span class={styles.pulse} />
                Working
              </span>
            </Show>
          </span>
          <Meta
            parts={[folderName(props.item.folder), props.item.agent, ...(lines() ? [signalLabel(lines()!)] : [])]}
          />
          <Show when={props.item.summary}>{(summary) => <span class={styles.summary}>{summary()}</span>}</Show>
          <Show when={dangers().length}>
            <span class={styles.pills}>
              <For each={dangers()}>{(sig) => <span class={styles.pill}>{signalLabel(sig)}</span>}</For>
            </span>
          </Show>
          <Show when={others().length}>
            <Meta
              parts={others().map((sig) => (
                <span data-tone={ATTENTION.includes(sig.kind) ? "attention" : undefined}>{signalLabel(sig)}</span>
              ))}
            />
          </Show>
          <Show when={props.item.secondOpinion}>
            {(opinion) => (
              <>
                <span class={styles.opinion} data-tone={opinionLook(opinion()).tone}>
                  <Icon icon={opinionLook(opinion()).icon} />
                  {opinionLabel(opinion())}
                </span>
                <Show
                  when={(() => {
                    const o = opinion();
                    return o.state === "failed" ? o.error : undefined;
                  })()}
                >
                  {(error) => <span class={styles.opinionError}>{error()}</span>}
                </Show>
              </>
            )}
          </Show>
        </span>
      </button>
      <div class={styles.actions}>
        <IconButton
          size="sm"
          icon={<Icon icon={UserRoundSearch} />}
          aria-label="Second opinion"
          tooltip={opinionRunning() ? "Second opinion running" : "Second opinion"}
          tooltipPlacement="top"
          tooltipWhenDisabled
          disabled={opinionRunning()}
          onClick={() =>
            void runSecondOpinion({ id: props.item.unit.id, cwd: props.item.folder, agent: props.item.agent })
          }
        />
        <IconButton
          size="sm"
          icon={
            marking() ? (
              <span class={styles.spin}>
                <Icon icon={LoaderCircle} />
              </span>
            ) : (
              <Icon icon={Check} />
            )
          }
          aria-label="Mark reviewed"
          aria-busy={marking()}
          tooltip={
            props.item.running
              ? "Still working. Mark it once its turn ends."
              : marking()
                ? "Marking reviewed"
                : "Mark reviewed"
          }
          tooltipPlacement="top"
          tooltipWhenDisabled
          disabled={props.item.running || marking()}
          onClick={() => void mark()}
        />
      </div>
    </li>
  );
}

function ReviewList() {
  return (
    <Show when={reviewItems().length} fallback={<Empty text="Nothing is waiting for review." />}>
      <For each={TIERS}>
        {(tier) => {
          const rows = () => reviewItems().filter((item) => tierOf(item.score) === tier);
          return (
            <Show when={rows().length}>
              <Group label={tier.label} count={rows().length} range={tier.range} tone={tier.tone} mark>
                <For each={rows()}>{(item) => <ReviewRow item={item} />}</For>
              </Group>
            </Show>
          );
        }}
      </For>
    </Show>
  );
}

const firstTab = (): InboxTab => {
  if (digestCount(digest()) > 0) return "since";
  return needsYouCount() > 0 || !reviewItems().length ? "needsYou" : "review";
};

export default function InboxView(props: { landing?: (el: HTMLElement) => void }) {
  const [tab, setTab] = createSignal<InboxTab>(askedTab() ?? firstTab());
  createEffect(() => {
    const asked = askedTab();
    if (!asked) return;
    setTab(asked);
    setAskedTab(null);
  });
  const views: { id: InboxTab; label: string; icon: LucideIcon; count: () => number }[] = [
    { id: "since", label: "Since you looked", icon: Clock, count: () => digestCount(digest()) },
    { id: "needsYou", label: "Needs you", icon: Hand, count: needsYouCount },
    { id: "permissions", label: "Permissions", icon: ShieldAlert, count: permissionCount },
    { id: "review", label: "Review", icon: ClipboardCheck, count: () => reviewItems().length },
  ];
  const toReview = () => setTab("review");
  return (
    <div class={styles.panel}>
      <header class={styles.head}>
        <h2 class={styles.heading}>Inbox</h2>
        <Show when={digest()}>{(d) => <span class={styles.chip}>Since {digestTime(d().since)}</span>}</Show>
      </header>
      <div class={styles.body}>
        <nav class={styles.rail} aria-label="Inbox views">
          <For each={views}>
            {(view) => (
              <button
                type="button"
                ref={(el) => view.id === tab() && props.landing?.(el)}
                class={`${s.railItem} ${styles.railItem}`}
                classList={{ [s.railItemActive]: tab() === view.id }}
                aria-current={tab() === view.id ? "page" : undefined}
                onClick={() => setTab(view.id)}
              >
                <Icon icon={view.icon} />
                <span class={s.railLabel}>{view.label}</span>{" "}
                <Show when={view.count() > 0}>
                  <span class={styles.count} data-warn={view.id === "needsYou" || view.id === "permissions"}>
                    {view.count()}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </nav>
        <OverlayScroll class={styles.scroll}>
          <div class={styles.content}>
            <Show when={tab() === "since"}>
              <SinceList onReview={toReview} />
            </Show>
            <Show when={tab() === "needsYou"}>
              <NeedsYouList onReview={toReview} />
            </Show>
            <Show when={tab() === "permissions"}>
              <PermissionList rows={permissionRows()} />
            </Show>
            <Show when={tab() === "review"}>
              <ReviewList />
            </Show>
          </div>
        </OverlayScroll>
      </div>
    </div>
  );
}
