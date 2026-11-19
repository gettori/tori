import { For, Match, Show, Switch } from "solid-js";
import {
  ArrowDownToLine,
  AtSign,
  Bot,
  ChevronRight,
  CircleHelp,
  Compass,
  File,
  FileCode,
  GitBranch,
  Hash,
  PanelsTopLeft,
  Search,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "lucide-solid";
import Icon from "../Icon/Icon";
import FileIcon from "../../seti/FileIcon";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import { segments } from "../../utils/fuzzy";
import type { CommandGroup } from "../../utils/commands";
import type { OmniMode } from "../../utils/omniboxModes";
import type { RowIcon, RowView } from "./rowView";
import styles from "./Omnibox.module.css";

const GROUP_GLYPHS: Record<CommandGroup, LucideIcon> = {
  navigate: Compass,
  view: PanelsTopLeft,
  search: Search,
  terminal: SquareTerminal,
  session: Bot,
  editor: FileCode,
  git: GitBranch,
  settings: Settings,
  help: CircleHelp,
};

export const MODE_GLYPHS: Record<OmniMode, LucideIcon> = {
  all: Search,
  file: File,
  command: ChevronRight,
  doc: AtSign,
  workspace: Hash,
  line: ArrowDownToLine,
  help: CircleHelp,
};

function Glyph(props: { icon: RowIcon }) {
  return (
    <Switch>
      <Match when={props.icon.kind === "file" && props.icon}>{(icon) => <FileIcon name={icon().name} />}</Match>
      <Match when={props.icon.kind === "symbol" && props.icon}>
        {(icon) => <SymbolIcon kind={icon().symbolKind} />}
      </Match>
      <Match when={props.icon.kind === "group" && props.icon}>
        {(icon) => <Icon icon={GROUP_GLYPHS[icon().group]} />}
      </Match>
      <Match when={props.icon.kind === "mode" && props.icon}>
        {(icon) => <Icon icon={MODE_GLYPHS[icon().mode]} />}
      </Match>
    </Switch>
  );
}

export default function OmniRow(props: { view: RowView }) {
  return (
    <>
      <span class={styles.itemIcon}>
        <Glyph icon={props.view.icon} />
      </span>
      <span class={styles.itemText}>
        <span class={styles.itemLabel}>
          <For each={segments(props.view.title, props.view.marks)}>
            {(seg) => (seg.marked ? <mark class={styles.mark}>{seg.text}</mark> : seg.text)}
          </For>
        </span>
        <Show when={props.view.subtitle}>{(sub) => <span class={styles.itemSub}>{sub()}</span>}</Show>
      </span>
      <Show when={props.view.keys}>
        {(keys) => (
          <span class={styles.itemKeys}>
            <span class={styles.srOnly}>{keys().spoken}</span>
            <For each={keys().chips}>
              {(key) => (
                <kbd class={styles.key} aria-hidden="true">
                  {key}
                </kbd>
              )}
            </For>
          </span>
        )}
      </Show>
    </>
  );
}
