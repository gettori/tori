import { For, Match, Show, Switch } from "solid-js";
import {
  ArrowDownToLine,
  AtSign,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  File,
  FileCode,
  Folder,
  GitBranch,
  GitPullRequest,
  Hash,
  LayoutGrid,
  Layers,
  MessageSquare,
  Palette,
  PanelsTopLeft,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  type IconGlyph,
} from "../Icon/icons";
import Icon from "../Icon/Icon";
import AgentGlyph from "../Icon/AgentGlyph";
import ProjectIcon from "../Icon/ProjectIcon";
import { resolveIcon } from "../Icon/iconRegistry";
import FileIcon from "../../seti/FileIcon";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import { segments } from "../../utils/fuzzy";
import type { CommandGroup } from "../../utils/commands";
import type { OmniMode } from "../../utils/omniboxModes";
import type { PlaceKind } from "../../utils/navIndex";
import type { Range } from "../../utils/fuzzy";
import type { RowIcon, RowView } from "./rowView";
import styles from "./Omnibox.module.css";
// The PR number takes the colour the sidebar's branch line gives it.
import lineStyles from "../../panels/LeftSidebar/BranchLine.module.css";

const GROUP_GLYPHS: Record<CommandGroup, IconGlyph> = {
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

export const MODE_GLYPHS: Record<OmniMode, IconGlyph> = {
  all: Search,
  file: File,
  command: ChevronRight,
  doc: AtSign,
  workspace: Hash,
  line: ArrowDownToLine,
  help: CircleHelp,
};

const PLACE_GLYPHS: Record<PlaceKind, IconGlyph> = {
  space: LayoutGrid,
  project: Folder,
  unit: GitBranch,
  topic: Layers,
  member: GitBranch,
  review: GitPullRequest,
  chat: MessageSquare,
  session: Bot,
};

type PlaceIcon = Extract<RowIcon, { kind: "place" }>;

function placeGlyph(icon: PlaceIcon): IconGlyph {
  if (icon.place === "space") return resolveIcon(icon.look?.icon) ?? LayoutGrid;
  if (icon.place === "unit" && icon.unitKind !== "worktree" && icon.unitKind !== "plain") return Folder;
  return PLACE_GLYPHS[icon.place];
}

function PlaceGlyph(props: { icon: PlaceIcon }) {
  return (
    <Show when={props.icon.place === "project" && props.icon.look} fallback={<Icon icon={placeGlyph(props.icon)} />}>
      {(look) => <ProjectIcon {...look()} />}
    </Show>
  );
}

function Marked(props: { text: string; marks: Range[] }) {
  return (
    <For each={segments(props.text, props.marks)}>
      {(seg) => (seg.marked ? <mark class={styles.mark}>{seg.text}</mark> : seg.text)}
    </For>
  );
}

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
      <Match when={props.icon.kind === "place" && props.icon}>{(icon) => <PlaceGlyph icon={icon()} />}</Match>
      <Match when={props.icon.kind === "lookup"}>
        <Icon icon={Search} />
      </Match>
      <Match when={props.icon.kind === "create"}>
        <Icon icon={Plus} />
      </Match>
      <Match when={props.icon.kind === "theme"}>
        <Icon icon={Palette} />
      </Match>
      <Match when={props.icon.kind === "agent" && props.icon}>
        {(icon) => <AgentGlyph id={icon().agentId} label={icon().label} size={16} />}
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
          <Marked text={props.view.title} marks={props.view.marks} />
        </span>
        <Show when={props.view.subtitle}>
          {(sub) => (
            <span class={styles.itemSub}>
              <Marked text={sub()} marks={props.view.subMarks} />
            </span>
          )}
        </Show>
      </span>
      <Show
        when={
          props.view.ticket ||
          props.view.pr ||
          props.view.dot ||
          props.view.value ||
          props.view.meter ||
          props.view.swatches ||
          props.view.check
        }
      >
        <span class={styles.accessories}>
          <Show when={props.view.ticket}>
            {(ticket) => (
              <>
                <span class={styles.chip} aria-hidden="true">
                  <Marked text={ticket().label} marks={ticket().marks} />
                </span>
                <span class={styles.srOnly}>{ticket().spoken}</span>
              </>
            )}
          </Show>
          <Show when={props.view.pr}>
            {(pr) => (
              <>
                <span class={`${styles.chip} ${lineStyles[`pr_${pr().tone}`] ?? ""}`} aria-hidden="true">
                  <Marked text={pr().label} marks={pr().marks} />
                </span>
                <span class={styles.srOnly}>{pr().spoken}</span>
              </>
            )}
          </Show>
          <Show when={props.view.dot}>
            {(dot) => (
              <>
                <span class={`${styles.dot} ${styles[dot().tone]}`} aria-hidden="true" />
                <span class={styles.srOnly}>{dot().spoken}</span>
              </>
            )}
          </Show>
          <Show when={props.view.value}>{(value) => <span class={styles.value}>{value()}</span>}</Show>
          <Show when={props.view.meter}>
            {(meter) => (
              <span class={[styles.meter, { [styles.isWarn]: meter().warn }]} aria-hidden="true">
                <span class={styles.meterFill} style={{ width: `${Math.round(meter().level * 100)}%` }} />
              </span>
            )}
          </Show>
          <Show when={props.view.swatches}>
            {(swatches) => (
              <span class={styles.swatches} aria-hidden="true">
                <For each={swatches()}>{(color) => <span class={styles.swatch} style={{ background: color }} />}</For>
              </span>
            )}
          </Show>
          <Show when={props.view.check}>
            {(check) => (
              <>
                <span class={[styles.check, { [styles.isOff]: check() === "off" }]} aria-hidden="true">
                  <Icon icon={Check} />
                </span>
                <Show when={check() === "on"}>
                  <span class={styles.srOnly}>Current</span>
                </Show>
              </>
            )}
          </Show>
        </span>
      </Show>
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
      <Show when={!props.view.keys && props.view.word}>
        <span class={styles.word}>{props.view.word}</span>
      </Show>
    </>
  );
}
