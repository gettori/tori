import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Ellipsis, MessageSquare } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import ContextMenu from "../../components/Menu/ContextMenu";
import Dropdown from "../../components/Menu/Dropdown";
import type { MenuItem } from "../../components/Menu/rows";
import type { Rollup } from "../../utils/sessionStatus";
import { NEW_CHAT_NAME, chatTime, type Chat } from "../../utils/chats";
import StatusBubble from "./StatusBubble";
import { EmptyRow, GroupHead } from "./SidebarRows";
import rows from "./SidebarRows.module.css";
import styles from "./ChatList.module.css";

export default function ChatList(props: {
  chats: Chat[];
  count: string;
  open: boolean;
  onToggle: () => void;
  selectedId: string | null;
  status: (c: Chat) => Rollup | null;
  menu: (c: Chat) => MenuItem[];
  onOpen: (c: Chat) => void;
  end?: () => Rollup | null;
}) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(tick));
  });

  return (
    <>
      <GroupHead
        label="Chats"
        count={props.count}
        open={props.open}
        onToggle={props.onToggle}
        end={<StatusBubble rollup={() => (props.open ? null : (props.end?.() ?? null))} />}
      />
      <Show when={props.open}>
        <ul class={styles.list} aria-label="Chats">
          <For each={props.chats} fallback={<EmptyRow>No chat matches the filter.</EmptyRow>}>
            {(c) => {
              const selected = () => props.selectedId === c.id;
              const busy = () => {
                const r = props.status(c);
                return !!r && r.waitingForApproval + r.waitingForAnswer + r.prAttention + r.executing > 0;
              };
              return (
                <ContextMenu
                  as="li"
                  class={`${rows.row} ${styles.chat}`}
                  classList={{ [styles.sel]: selected() }}
                  items={props.menu(c)}
                  aria-current={selected() ? "true" : undefined}
                  data-chat={c.id}
                  onClick={() => props.onOpen(c)}
                >
                  <span class={`${rows.rowIcon} ${styles.icon}`}>
                    <Icon icon={MessageSquare} />
                  </span>
                  <span class={`${rows.label} ${styles.name}`} classList={{ [styles.untitled]: !c.name }}>
                    {c.name ?? NEW_CHAT_NAME}
                  </span>
                  <span class={`${rows.rowEnd} ${styles.end}`}>
                    <Show
                      when={busy()}
                      fallback={
                        <time class={styles.time} dateTime={new Date(c.updated).toISOString()}>
                          {chatTime(c.updated, now())}
                        </time>
                      }
                    >
                      <StatusBubble rollup={() => props.status(c)} />
                    </Show>
                  </span>
                  <span class={styles.menu} onClick={(e) => e.stopPropagation()}>
                    <Dropdown as="span" wrapper items={props.menu(c)} placement="bottom-end">
                      <IconButton
                        size="sm"
                        class={rows.rowMenuBtn}
                        icon={<Icon icon={Ellipsis} />}
                        tooltip={`Actions for ${c.name ?? NEW_CHAT_NAME}`}
                      />
                    </Dropdown>
                  </span>
                </ContextMenu>
              );
            }}
          </For>
        </ul>
      </Show>
    </>
  );
}
