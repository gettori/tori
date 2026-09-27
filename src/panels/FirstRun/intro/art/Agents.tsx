import { For, Show, createSignal } from "solid-js";
import {
  Bot,
  Braces,
  Bug,
  Columns2,
  FileCode,
  FolderCog,
  ListChecks,
  MessageSquare,
  Palette,
  Plug,
  Plus,
  ShieldCheck,
  Smartphone,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-solid";
import { WheelGlyph } from "../../../../components/Autopilot/Wheel";
import Button from "../../../../components/Button/Button";
import { DialogSurface } from "../../../../components/Dialog/surface";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import { GitHubLogo, GitLabLogo } from "../../../../components/Icon/gitMarks";
import Switch from "../../../../components/Switch/Switch";
import AgentPalette from "../../../Chat/AgentPalette";
import { lockedProvider } from "../../../Chat/agentPaletteData";
import settings from "../../../Settings/Settings.module.css";
import cards from "../../../Settings/panes/IntegrationsPane/ForgeSection.module.css";
import type { Adapter } from "../../../../utils/agents";
import type { PickableModel } from "../../../../utils/chatModels";
import { SETTING_TABS } from "../../../../utils/settingsCatalog";
import MiniWindow from "./MiniWindow";
import styles from "./Agents.module.css";

const TAB_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  "message-square": MessageSquare,
  "file-code": FileCode,
  braces: Braces,
  bug: Bug,
  "list-checks": ListChecks,
  "wand-sparkles": WandSparkles,
  "shield-check": ShieldCheck,
  palette: Palette,
  wheel: WheelGlyph as LucideIcon,
  plug: Plug,
  "columns-2": Columns2,
  "folder-cog": FolderCog,
  smartphone: Smartphone,
};

function adapter(id: string, label: string): Adapter {
  return {
    id,
    label,
    program: id,
    base_args: [],
    yolo_args: [],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: null,
  };
}

function model(value: string, label: string, description = ""): PickableModel {
  return {
    value,
    resolvedModel: value,
    label,
    description,
    effortLevels: [],
    contextWindow: null,
    live: false,
    userConfigured: false,
    fastMode: false,
    supportsAutoMode: false,
  };
}

const PROVIDERS = [
  lockedProvider(adapter("claude", "Claude"), [
    model("opus", "Opus 5.5", "Slowest and strongest"),
    model("sonnet", "Sonnet 5", "Balanced, the everyday one"),
    model("haiku", "Haiku 4.5", "Cheap and quick"),
  ]),
  lockedProvider(adapter("codex", "Codex"), [model("gpt-5", "GPT-5"), model("gpt-5-mini", "GPT-5 mini")]),
  lockedProvider(adapter("gemini", "Gemini"), [model("gemini-3-pro", "Gemini 3 Pro"), model("gemini-3-flash", "Gemini 3 Flash")]),
  lockedProvider(adapter("opencode", "OpenCode"), [model("sonnet-5", "Sonnet 5"), model("gpt-5", "GPT-5")]),
];

type Host = {
  host: string;
  family: "GitHub" | "GitLab";
  login: string;
  source: string;
  push: boolean;
  everywhere: boolean;
};

const HOSTS: Host[] = [
  { host: "github.com", family: "GitHub", login: "octocat", source: "GitHub CLI", push: true, everywhere: true },
  { host: "gitlab.com", family: "GitLab", login: "a.mehta", source: "browser", push: true, everywhere: false },
];

const noop = () => {};

// ForgeSection loads its accounts through `invoke` on mount, so its host card
// is restated here from the section's own stylesheet and controls.
function HostCard(props: Host) {
  return (
    <div class={cards.card}>
      <div class={cards.head}>
        <span class={cards.logo}>
          <Show when={props.family === "GitLab"} fallback={<GitHubLogo size="calc(16px * var(--ui-scale))" />}>
            <GitLabLogo size="calc(16px * var(--ui-scale))" />
          </Show>
        </span>
        <span class={cards.host}>{props.host}</span>
        <span class={cards.tag} data-family={props.family}>
          {props.family}
        </span>
        <span class={cards.spacer} />
        <Button variant="ghost">Add account</Button>
      </div>
      <div class={cards.account}>
        <div class={cards.line}>
          <span class={cards.dot} data-auth="signedIn" />
          <span class={cards.login}>{props.login}</span>
          <span class={cards.word} data-auth="signedIn">
            signed in
          </span>
          <span class={cards.source}>via {props.source}</span>
          <Button variant="ghost" size="xs" class={cards.remove}>
            Remove
          </Button>
        </div>
      </div>
      <div class={cards.footer}>
        <div class={cards.footerText}>
          <div class={cards.footerLabel}>
            <span>Use this account for git push and fetch</span>
          </div>
          <div class={cards.footerNote}>Covers Tori's own git, terminal tabs and agents.</div>
        </div>
        <Switch aria-label={`Use ${props.host} for git push and fetch`} checked={props.push} onChange={noop} />
      </div>
      <div class={cards.footer} classList={{ [cards.footerInert]: !props.push }}>
        <div class={cards.footerText}>
          <div class={cards.footerLabel}>
            <span>Use for git everywhere</span>
          </div>
          <div class={cards.footerNote}>Your own terminal and editor too.</div>
        </div>
        <Switch aria-label={`Use ${props.host} for git everywhere`} checked={props.everywhere} onChange={noop} />
      </div>
    </div>
  );
}

function SettingsWindow() {
  return (
    <MiniWindow height={470} zoom={0.68} class={styles.window}>
      <div class={`${settings.panel} ${styles.settings}`}>
        <div class={settings.header}>
          <div class={settings.title}>Settings</div>
          <IconButton icon={<Icon icon={X} />} size="sm" aria-label="Close" />
        </div>
        <div class={settings.body}>
          <div class={settings.railCol}>
            <div class={settings.railSearch}>
              <input class={settings.searchInput} type="search" placeholder="Search all settings" tabindex="-1" />
            </div>
            <div class={settings.rail}>
              <For each={SETTING_TABS}>
                {(t, i) => (
                  <>
                    <Show when={i() === 0 || SETTING_TABS[i() - 1].group !== t.group}>
                      <div class={settings.railGroup}>{t.group}</div>
                    </Show>
                    <div class={settings.railItem} classList={{ [settings.railItemActive]: t.id === "integrations" }}>
                      <Icon icon={TAB_ICONS[t.icon] ?? Plug} />
                      <span class={settings.railLabel}>{t.label}</span>
                    </div>
                  </>
                )}
              </For>
            </div>
          </div>
          <div class={settings.pane}>
            <div class={settings.paneInner}>
              <section class={settings.section}>
                <div class={settings.sectionTitle}>
                  <span>Hosts</span>
                  <span class={settings.sectionRule} />
                  <IconButton size="sm" icon={<Icon icon={Plus} />} aria-label="Connect a host" />
                </div>
                <div class={cards.stack}>
                  <For each={HOSTS}>{(h) => <HostCard {...h} />}</For>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </MiniWindow>
  );
}

/** Slide 06: the real model palette over the Settings hosts pane. */
export default function AgentsArt() {
  const [mount, setMount] = createSignal<HTMLElement>();
  return (
    <div class={styles.stage} inert>
      <SettingsWindow />
      <div class={styles.privacy}>
        <span class={styles.shield}>
          <Icon icon={ShieldCheck} size={15} />
        </span>
        <span class={styles.privacyText}>
          <span class={styles.privacyTitle}>No telemetry</span>
          <span class={styles.privacyNote}>Runs on this machine, as you</span>
        </span>
      </div>
      {/* The palette portals into this box through the dialog surface, so it
          lands here and not on the body. */}
      <div class={styles.palette} ref={setMount}>
        <Show when={mount()}>
          <DialogSurface.Provider value={mount}>
            <AgentPalette providers={PROVIDERS} agentId="claude" profile={null} value="opus" onSelect={noop} onClose={noop} />
          </DialogSurface.Provider>
        </Show>
      </div>
    </div>
  );
}
