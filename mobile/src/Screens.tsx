import { For, Match, Switch } from "solid-js";
import { ChevronLeft, Folder } from "lucide-solid";
import Icon from "../../src/components/Icon/Icon";
import { BranchMark, WorktreeMark } from "../../src/components/Icon/gitMarks";
import type { RemoteClient } from "./remote";
import { Chevron, DOT, Offline, StateMark } from "./Root";
import { inUnit, rollupOf, type Project, type SessionRow, type Topic, type Tree, type Unit } from "./tree";
import styles from "./shell.module.css";

const KIND: Record<Unit["kind"], string> = { worktree: "worktree", incomplete: "worktree", plain: "branch", "plain-dir": "folder" };

function UnitIcon(props: { unit: Unit; active: boolean }) {
  return (
    <Switch fallback={<Icon icon={Folder} size={18} />}>
      <Match when={props.unit.kind === "worktree" || props.unit.kind === "incomplete"}>
        <WorktreeMark active={props.active} current={props.unit.isCurrent} stub={props.unit.kind === "incomplete"} />
      </Match>
      <Match when={props.unit.kind === "plain"}>
        <BranchMark active={props.active} current={props.unit.isCurrent} />
      </Match>
    </Switch>
  );
}

function UnitItem(props: { unit: Unit; name?: string; meta: string; live: SessionRow[]; onOpen: () => void }) {
  const rows = () => props.live.filter((row) => inUnit(row.home, props.unit));
  return (
    <li>
      <button class={styles.item} onClick={() => props.onOpen()}>
        <UnitIcon unit={props.unit} active={rollupOf(rows()).executing > 0} />
        <span class={styles.text}>
          <span class={styles.name}>{props.name ?? props.unit.label}</span>
          <span class={styles.meta}>{props.meta}</span>
        </span>
        <StateMark rows={rows()} />
        <Chevron />
      </button>
    </li>
  );
}

function PushTop(props: { back: string; onBack: () => void }) {
  return (
    <header class={styles.pushTop}>
      <button class={styles.circle} aria-label="Back" onClick={() => props.onBack()}>
        <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
      </button>
      <span class={styles.backLabel}>{props.back}</span>
    </header>
  );
}

export function ProjectScreen(props: {
  client: RemoteClient;
  project: Project;
  space: string;
  live: () => SessionRow[];
  onUnit: (unit: Unit) => void;
  onBack: () => void;
}) {
  const sessions = (unit: Unit) => props.live().filter((row) => inUnit(row.home, unit)).length;
  return (
    <div class={styles.glow}>
      <PushTop back={props.space} onBack={props.onBack} />
      <Offline client={props.client} />
      <div class={styles.scroll}>
        <h1 class={styles.screenTitle}>{props.project.name}</h1>
        <h2 class={styles.label}>Worktrees</h2>
        <ul class={styles.group}>
          <For each={props.project.units}>
            {(unit) => (
              <UnitItem
                unit={unit}
                meta={sessions(unit) > 0 ? `${sessions(unit)} live` : KIND[unit.kind]}
                live={props.live()}
                onOpen={() => props.onUnit(unit)}
              />
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}

export function memberUnit(tree: Tree | undefined, topic: Topic, member: Topic["members"][number]): Unit {
  const known = tree?.spaces.flatMap((s) => s.projects.flatMap((p) => p.units)).find((u) => u.folder === member.worktreePath);
  return known ?? { label: member.displayName, folder: member.worktreePath, branch: topic.branch, kind: "worktree", isCurrent: false };
}

export function TopicScreen(props: {
  client: RemoteClient;
  topic: Topic;
  tree: Tree | undefined;
  live: () => SessionRow[];
  onUnit: (unit: Unit) => void;
  onBack: () => void;
}) {
  const members = () => [...props.topic.members].sort((a, b) => a.order - b.order);
  return (
    <div class={styles.glow}>
      <PushTop back="Topics" onBack={props.onBack} />
      <Offline client={props.client} />
      <div class={styles.scroll}>
        <h1 class={styles.screenTitle}>{props.topic.name}</h1>
        <h2 class={styles.label}>Members {DOT} {members().length}</h2>
        <ul class={styles.group}>
          <For each={members()} fallback={<li class={styles.empty}>No members</li>}>
            {(member) => {
              const unit = memberUnit(props.tree, props.topic, member);
              return (
                <UnitItem unit={unit} name={member.displayName} meta={unit.branch ?? props.topic.branch} live={props.live()} onOpen={() => props.onUnit(unit)} />
              );
            }}
          </For>
        </ul>
      </div>
    </div>
  );
}
