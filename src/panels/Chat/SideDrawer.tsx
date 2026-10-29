import { createSignal, For, Show } from "solid-js";
import { Plus } from "lucide-solid";
import ChatView from "./ChatView";
import OverflowTabBar from "../../components/OverflowTabBar";
import Tab from "../../components/Tab/Tab";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Resizer from "../../components/Resizer/Resizer";
import { closeSide, drawerOf, markSideStarted, openSide, selectSide, sideLabel } from "./sideChats";
import styles from "./SideDrawer.module.css";

const WIDTH_MIN = 320;
const WIDTH_START = 440;

/** The side chats of one chat tab, as tabs in a drawer on its right. */
export default function SideDrawer(props: {
  parentTab: string;
  parentSession: string;
  agentId: string;
  profile: string | null;
  cwd: string;
  workspace: string;
  active: boolean;
}) {
  const [width, setWidth] = createSignal(WIDTH_START);
  const drawer = () => drawerOf(props.parentTab);

  return (
    <Show when={drawer().sides.length > 0}>
      <Resizer side="after" variant="hairline" value={width()} min={WIDTH_MIN} onInput={setWidth} />
      <aside class={styles.drawer} style={{ width: `${width()}px` }} aria-label="Side chats">
        <OverflowTabBar
          class={styles.tabs}
          items={drawer().sides}
          activeId={drawer().active}
          idOf={(s) => s.tabId}
          onActivate={(id) => selectSide(props.parentTab, id)}
          onReorder={() => {}}
          trailing={
            <IconButton
              size="sm"
              icon={<Icon icon={Plus} />}
              tooltip="Open another side chat"
              onClick={() => openSide(props.parentTab)}
            />
          }
          renderTab={(side) => (
            <Tab value={side.tabId} onClose={() => closeSide(props.parentTab, side.tabId)}>
              {sideLabel(side)}
            </Tab>
          )}
          renderMenuItem={(side) => <span class="tab-name">{sideLabel(side)}</span>}
        />
        <For each={drawer().sides}>
          {(side) => (
            <div class={styles.body} classList={{ [styles.hidden]: drawer().active !== side.tabId }}>
              <ChatView
                sessionId={side.sessionId}
                tabId={side.tabId}
                agentId={props.agentId}
                profile={props.profile}
                cwd={props.cwd}
                workspace={props.workspace}
                title={sideLabel(side)}
                resume={side.restored === true}
                started={!side.restored || side.started}
                onStart={() => markSideStarted(props.parentTab, side.tabId)}
                forkFrom={side.restored ? undefined : props.parentSession}
                sideOf={props.parentSession}
                active={props.active && drawer().active === side.tabId}
                onRewindFrom={() => {}}
                onFirstSendFailed={() => {}}
                onProfileResolved={() => {}}
              />
            </div>
          )}
        </For>
      </aside>
    </Show>
  );
}
