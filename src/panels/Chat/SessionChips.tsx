import { For, Show, createSignal, type Component } from "solid-js";
import { GitFork, Link2, MessageSquare } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import { WorktreeMark } from "../../components/Icon/gitMarks";
import Popover from "../../components/Popover/Popover";
import Tooltip from "../../components/Tooltip/Tooltip";
import Tip from "./Tip";
import styles from "./Chat.module.css";

export type Relation = "spawned" | "madeWorktree" | "prompted" | "linked";
export type RelatedState = "working" | "needsYou" | "idle" | "done";

export type Side = "from" | "to";

export type RelatedSession = {
  id: string;
  name: string;
  side: Side;
  relation: Relation;
  state: RelatedState;
  project: string | null;
  branch: string | null;
  lastAt: number;
};

const where = (s: RelatedSession) => (s.project && s.branch ? `${s.project} / ${s.branch}` : s.project);

const SHOWN = 2;

const GLYPH: Record<Relation, Component> = {
  spawned: () => <Icon icon={GitFork} size={12} />,
  madeWorktree: () => <WorktreeMark size={12} active={false} />,
  prompted: () => <Icon icon={MessageSquare} size={12} />,
  linked: () => <Icon icon={Link2} size={12} />,
};

const SAYS: Record<Side, Record<Relation, string>> = {
  from: {
    spawned: "Started this chat",
    madeWorktree: "Made the worktree this chat runs in",
    prompted: "Sent this chat a prompt",
    linked: "Linked with this chat",
  },
  to: {
    spawned: "Started from here",
    madeWorktree: "Runs in a worktree made here",
    prompted: "Prompted from here",
    linked: "Linked with this chat",
  },
};

const STATE: Record<RelatedState, string> = {
  working: "Working",
  needsYou: "Needs you",
  idle: "Idle",
  done: "Done",
};

const tone = (state: RelatedState) =>
  state === "working" ? styles.laneBusy : state === "needsYou" ? styles.laneBlocked : styles.laneIdle;

const live = (s: RelatedSession) => s.state === "working" || s.state === "needsYou";
const startedThis = (s: RelatedSession) =>
  s.side === "from" && (s.relation === "spawned" || s.relation === "madeWorktree");

// The chat that started this one explains it, so it never folds away behind
// peers that happen to be busier or more recent.
export function ordered(sessions: readonly RelatedSession[]): RelatedSession[] {
  return [...sessions].sort(
    (a, b) =>
      Number(startedThis(b)) - Number(startedThis(a)) || Number(live(b)) - Number(live(a)) || b.lastAt - a.lastAt,
  );
}

const GROUPS: { title: string; holds: (s: RelatedSession) => boolean }[] = [
  {
    title: "Started this chat",
    holds: (s) => s.side === "from" && (s.relation === "spawned" || s.relation === "madeWorktree"),
  },
  { title: "Prompted this chat", holds: (s) => s.side === "from" && s.relation === "prompted" },
  {
    title: "Started from here",
    holds: (s) => s.side === "to" && (s.relation === "spawned" || s.relation === "madeWorktree"),
  },
  { title: "Prompted from here", holds: (s) => s.side === "to" && s.relation === "prompted" },
  { title: "Linked", holds: (s) => s.relation === "linked" },
];

export function grouped(sessions: readonly RelatedSession[]): { title: string; sessions: RelatedSession[] }[] {
  return GROUPS.map((g) => ({ title: g.title, sessions: ordered(sessions.filter(g.holds)) })).filter(
    (g) => g.sessions.length > 0,
  );
}

export default function SessionChips(props: {
  sessions: readonly RelatedSession[];
  onOpen?: (id: string) => void;
  onUnlink?: (id: string) => void;
}) {
  const [listOpen, setListOpen] = createSignal(false);
  let more: HTMLButtonElement | undefined;

  const onSide = (side: Side) => ordered(props.sessions.filter((s) => s.side === side));
  const hidden = () => onSide("from").slice(SHOWN).length + onSide("to").slice(SHOWN).length;

  const Chip = (p: { session: RelatedSession }) => (
    <Tooltip
      as="button"
      type="button"
      class={styles.lane}
      classList={{ [styles.laneStill]: !props.onOpen }}
      label={
        <Tip
          heading={p.session.name}
          lines={[
            SAYS[p.session.side][p.session.relation],
            STATE[p.session.state],
            ...(where(p.session) ? [where(p.session)!] : []),
          ]}
          hint={props.onOpen ? "Click to open that chat" : null}
        />
      }
      data-related-session={p.session.id}
      onClick={() => props.onOpen?.(p.session.id)}
    >
      <span class={`${styles.laneDot} ${tone(p.session.state)}`} aria-hidden="true" />
      <span class={styles.sessionGlyph} aria-hidden="true">
        {GLYPH[p.session.relation]({})}
      </span>
      <span class={styles.laneLabel}>{p.session.name}</span>
    </Tooltip>
  );

  const Group = (p: { side: Side; name: string }) => (
    <Show when={onSide(p.side).length > 0}>
      <span class={styles.laneGroupName}>{p.name}</span>
      <For each={onSide(p.side).slice(0, SHOWN)}>{(session) => <Chip session={session} />}</For>
    </Show>
  );

  return (
    <Show when={props.sessions.length > 0}>
      <div class={styles.laneGroup} role="group" aria-label="Related sessions">
        <Group side="from" name="From" />
        <Group side="to" name="To" />
        <Show when={hidden() > 0}>
          <button
            ref={more}
            type="button"
            class={`${styles.lane} ${styles.laneMore}`}
            aria-expanded={listOpen()}
            onClick={() => setListOpen(!listOpen())}
          >
            {`+${hidden()}`}
          </button>
        </Show>
        <Show when={listOpen()}>
          <Popover
            anchorEl={more}
            placement="top-start"
            onClose={() => setListOpen(false)}
            aria-label="Related sessions"
          >
            <div class={styles.sessionList}>
              <For each={grouped(props.sessions)}>
                {(group) => (
                  <section>
                    <h4 class={styles.sessionListTitle}>{group.title}</h4>
                    <For each={group.sessions}>
                      {(s) => (
                        <div class={styles.sessionRow}>
                          <button
                            type="button"
                            class={styles.sessionRowOpen}
                            disabled={!props.onOpen}
                            onClick={() => {
                              setListOpen(false);
                              props.onOpen?.(s.id);
                            }}
                          >
                            <span class={`${styles.laneDot} ${tone(s.state)}`} aria-hidden="true" />
                            <span class={styles.sessionGlyph} aria-hidden="true">
                              {GLYPH[s.relation]({})}
                            </span>
                            <span class={styles.laneLabel}>{s.name}</span>
                            <Show when={where(s)}>{(w) => <span class={styles.sessionWhere}>{w()}</span>}</Show>
                          </button>
                          <Show when={s.relation === "linked" && props.onUnlink}>
                            <button type="button" class={styles.sessionUnlink} onClick={() => props.onUnlink?.(s.id)}>
                              Unlink
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </div>
          </Popover>
        </Show>
      </div>
    </Show>
  );
}
