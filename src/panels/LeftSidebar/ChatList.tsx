import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { MessageSquare } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import type { MenuItem } from "../../components/Menu/rows";
import { needsYouOrWorking, type Rollup } from "../../utils/sessionStatus";
import { NEW_CHAT_NAME, OLDER_AFTER, chatTime, type Chat } from "../../utils/chats";
import StatusBubble from "./StatusBubble";
import { BranchRow, EmptyRow, GroupHead, MoreRow } from "./SidebarRows";
import { GROUP_CAP, capList, moreLabel } from "./capList";
import rows from "./SidebarRows.module.css";
import styles from "./ChatList.module.css";

export default function ChatList(props: {
  chats: Chat[];
  count: string;
  filtered: boolean;
  open: boolean;
  onToggle: () => void;
  moreOpen: boolean;
  onToggleMore: () => void;
  olderOpen: boolean;
  onToggleOlder: () => void;
  selectedId: string | null;
  status: (c: Chat) => Rollup | null;
  rollupOf: (chats: readonly Chat[]) => Rollup | null;
  menu: (c: Chat) => MenuItem[];
  onOpen: (c: Chat) => void;
  onAdd: () => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(tick));
  });

  const kept = (c: Chat) => props.selectedId === c.id || needsYouOrWorking(props.status(c));
  // A filter lists every match: a fold would hide the very rows it found.
  const split = createMemo(() => {
    if (props.filtered) return { recent: props.chats, shown: props.chats, hidden: [] as Chat[], older: [] as Chat[] };
    const recent: Chat[] = [];
    const older: Chat[] = [];
    for (const c of props.chats) (now() - c.updated > OLDER_AFTER && !kept(c) ? older : recent).push(c);
    if (props.moreOpen) return { recent, shown: recent, hidden: [] as Chat[], older };
    return { recent, ...capList(recent, GROUP_CAP, kept), older };
  });
  const folds = () => (props.moreOpen ? split().recent.length > GROUP_CAP : split().hidden.length > 0);

  const chatRow = (c: Chat) => (
    <BranchRow
      label={c.name ?? NEW_CHAT_NAME}
      icon={<Icon icon={MessageSquare} />}
      selected={props.selectedId === c.id}
      end={
        <Show
          when={needsYouOrWorking(props.status(c))}
          fallback={
            <time class={styles.time} dateTime={new Date(c.updated).toISOString()}>
              {chatTime(c.updated, now())}
            </time>
          }
        >
          <StatusBubble rollup={() => props.status(c)} />
        </Show>
      }
      menu={props.menu(c)}
      onClick={() => props.onOpen(c)}
      rowProps={{ "data-chat": c.id }}
    />
  );

  return (
    <>
      <GroupHead
        label="Chats"
        count={props.count}
        filtered={props.filtered}
        open={props.open}
        onToggle={props.onToggle}
        end={<StatusBubble rollup={() => (props.open ? null : props.rollupOf(props.chats))} />}
        addLabel={NEW_CHAT_NAME}
        onAdd={props.onAdd}
      />
      <Show when={props.open}>
        <div class={rows.projectCard}>
          <For
            each={split().shown}
            fallback={
              <Show when={props.filtered}>
                <EmptyRow>No chat matches the filter.</EmptyRow>
              </Show>
            }
          >
            {chatRow}
          </For>
          <Show when={folds()}>
            <MoreRow
              label={props.moreOpen ? "Show less" : moreLabel(split().hidden.length, ["chat", "chats"])}
              open={props.moreOpen}
              end={<StatusBubble rollup={() => (props.moreOpen ? null : props.rollupOf(split().hidden))} />}
              onClick={props.onToggleMore}
            />
          </Show>
          <Show when={split().older.length > 0}>
            <MoreRow
              label="Older"
              open={props.olderOpen}
              end={<StatusBubble rollup={() => (props.olderOpen ? null : props.rollupOf(split().older))} />}
              onClick={props.onToggleOlder}
            />
            <Show when={props.olderOpen}>
              <For each={split().older}>{chatRow}</For>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  );
}
