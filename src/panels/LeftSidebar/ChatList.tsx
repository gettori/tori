import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { MessageSquare } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import type { MenuItem } from "../../components/Menu/rows";
import type { Rollup } from "../../utils/sessionStatus";
import { NEW_CHAT_NAME, chatTime, type Chat } from "../../utils/chats";
import StatusBubble from "./StatusBubble";
import { BranchRow, EmptyRow, GroupHead } from "./SidebarRows";
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
        <div class={rows.projectCard}>
          <For each={props.chats} fallback={<EmptyRow>No chat matches the filter.</EmptyRow>}>
            {(c) => {
              const busy = () => {
                const r = props.status(c);
                return !!r && r.waitingForApproval + r.waitingForAnswer + r.prAttention + r.executing > 0;
              };
              return (
                <BranchRow
                  label={c.name ?? NEW_CHAT_NAME}
                  icon={<Icon icon={MessageSquare} />}
                  selected={props.selectedId === c.id}
                  end={
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
                  }
                  menu={props.menu(c)}
                  onClick={() => props.onOpen(c)}
                  rowProps={{ "data-chat": c.id }}
                />
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
}
