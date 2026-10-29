import { For, Show, type JSX } from "solid-js";
import {
  FileDiff,
  FoldVertical,
  GitFork,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  ScrollText,
  UnfoldVertical,
  X,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import { drawerOf, removeSide, reopenSide, selectSide, sideLabel, type SideChat } from "./sideChats";
import styles from "./Chat.module.css";

// The status strip closes its menu on a click that lands on one of these.
const CLOSES = { "data-closes-menu": "" };

function MenuButton(props: { icon: LucideIcon; hint: string; onClick: () => void; children: JSX.Element }) {
  return (
    <Tooltip as="button" type="button" class={styles.menuRow} label={props.hint} onClick={props.onClick} {...CLOSES}>
      <Icon icon={props.icon} />
      <span class={styles.menuRowLabel}>{props.children}</span>
    </Tooltip>
  );
}

function SideChats(props: { parentTab: string; canOpen: boolean; onNew: () => void }) {
  const drawer = () => drawerOf(props.parentTab);
  const all = () => [...drawer().sides, ...drawer().closed].sort((a, b) => a.n - b.n);
  const isOpen = (side: SideChat) => drawer().sides.some((s) => s.tabId === side.tabId);
  const state = (side: SideChat) => {
    if (!isOpen(side)) return "Closed";
    return drawer().active === side.tabId ? "In front" : "Open";
  };

  return (
    <section class={styles.menuSection} aria-label="Side chats">
      <div class={styles.menuHeading}>
        <span>Side chats</span>
        <Show when={props.canOpen}>
          <IconButton
            size="xs"
            icon={<Icon icon={Plus} />}
            tooltip="New side chat"
            onClick={() => props.onNew()}
            {...CLOSES}
          />
        </Show>
      </div>
      <For each={all()}>
        {(side) => (
          <div class={styles.sideRow}>
            <Tooltip
              as="button"
              type="button"
              class={styles.menuRow}
              label={isOpen(side) ? "Show it in the drawer" : "Reopen it, still read-only"}
              onClick={() =>
                isOpen(side) ? selectSide(props.parentTab, side.tabId) : reopenSide(props.parentTab, side.tabId)
              }
              {...CLOSES}
            >
              <span class={styles.sideDot} classList={{ [styles.sideDotOpen]: isOpen(side) }} aria-hidden="true" />
              <span class={styles.menuRowLabel}>{sideLabel(side)}</span>
              <span class={styles.menuRowHint}>{state(side)}</span>
            </Tooltip>
            <IconButton
              size="xs"
              class={styles.sideRowRemove}
              icon={<Icon icon={X} />}
              tooltip={`Remove ${sideLabel(side)}. Its transcript stays in History.`}
              onClick={() => removeSide(props.parentTab, side.tabId)}
            />
          </div>
        )}
      </For>
    </section>
  );
}

export default function SessionMenu(props: {
  showDiff: boolean;
  onToggleDiff: () => void;
  collapseWork: boolean;
  onToggleCollapse: () => void;
  onSendToNew?: () => void;
  onFork?: () => void;
  sides?: { parentTab: string; canOpen: boolean; onNew: () => void };
  footer: JSX.Element;
}) {
  const hasSides = () =>
    !!props.sides && drawerOf(props.sides.parentTab).sides.length + drawerOf(props.sides.parentTab).closed.length > 0;
  const branches = () => !!props.onSendToNew || !!props.onFork || (!!props.sides?.canOpen && !hasSides());

  return (
    <div class={styles.sessionMenu}>
      <MenuButton
        icon={props.showDiff ? ScrollText : FileDiff}
        hint={
          props.showDiff
            ? "Back to the turn-by-turn transcript"
            : "See every file this session changed, as one diff per file"
        }
        onClick={() => props.onToggleDiff()}
      >
        {props.showDiff ? "Show transcript" : "Show changes as a diff"}
      </MenuButton>
      <MenuButton
        icon={props.collapseWork ? UnfoldVertical : FoldVertical}
        hint={
          props.collapseWork
            ? "Show thinking, tool calls and hooks in the transcript again, in every chat"
            : "Fold thinking, tool calls and hooks into one line between replies, in every chat"
        }
        onClick={() => props.onToggleCollapse()}
      >
        {props.collapseWork ? "Show agent work" : "Collapse agent work"}
      </MenuButton>
      <Show when={branches()}>
        <hr class={styles.menuDivider} />
        <Show when={props.onSendToNew}>
          {(send) => (
            <MenuButton
              icon={MessageSquarePlus}
              hint="Open a new chat and send what is in the composer to it"
              onClick={() => send()()}
            >
              Send to a new chat
            </MenuButton>
          )}
        </Show>
        <Show when={props.onFork}>
          {(fork) => (
            <MenuButton
              icon={GitFork}
              hint="Branch this conversation into a new session, keeping everything up to here"
              onClick={() => fork()()}
            >
              Fork this chat
            </MenuButton>
          )}
        </Show>
        <Show when={props.sides?.canOpen && !hasSides()}>
          <MenuButton
            icon={MessagesSquare}
            hint="Ask about this session beside it, in a read-only copy that cannot change anything"
            onClick={() => props.sides?.onNew()}
          >
            New side chat
          </MenuButton>
        </Show>
      </Show>
      <Show when={hasSides() && props.sides}>
        {(sides) => (
          <>
            <hr class={styles.menuDivider} />
            <SideChats parentTab={sides().parentTab} canOpen={sides().canOpen} onNew={sides().onNew} />
          </>
        )}
      </Show>
      <div class={styles.menuFooter}>{props.footer}</div>
    </div>
  );
}
