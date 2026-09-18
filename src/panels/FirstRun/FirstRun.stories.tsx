import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, type JSX } from "solid-js";
import Button from "../../components/Button/Button";
import type { AgentHealth } from "../../utils/agentHealth";
import type { FirstRunSpace } from "../../utils/firstRun";
import type { ForgeHost } from "../../utils/forgeTypes";
import type { GitReport } from "../../utils/gitHealth";
import type { NewProjectMode } from "../../utils/newProject";
import DeviceWaitCard from "../Settings/panes/IntegrationsPane/DeviceWaitCard";
import type { Cloud, Failure } from "../Settings/panes/IntegrationsPane/forgeAddFlow";
import FirstRunShell, { StepRail, type RailStep } from "./FirstRunShell";
import AgentsStep, { AGENTS_LEAD, type Command } from "./steps/AgentsStep";
import BaseFolderStep, { BASE_FOLDER_LEAD } from "./steps/BaseFolderStep";
import HostsStep, { HOSTS_LEAD } from "./steps/HostsStep";
import ProjectStep, { PROJECT_LABEL, PROJECT_LEAD, gitMissing } from "./steps/ProjectStep";
import ReadyStep, { readyLead, type ReadySummary } from "./steps/ReadyStep";
import SpaceStep, { SPACE_LEAD, type SpaceMode } from "./steps/SpaceStep";
import styles from "./FirstRun.module.css";

const HOME = "/Users/rowan";
const ROOT = `${HOME}/Projects`;
const space = (name: string, n: number): FirstRunSpace => ({
  name,
  path: `${ROOT}/${name}`,
  projects: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, path: `${ROOT}/${name}/p${i}` })),
});
const SPACES = [space("work", 6), space("personal", 5), space("acme", 3)];

const STEPS: RailStep[] = [
  { id: "agents", label: "Agents", group: "setup", summary: "3 found" },
  { id: "base", label: "Base folder", required: true, group: "setup", summary: "~/Projects" },
  { id: "space", label: "Space", required: true, group: "setup", summary: "work" },
  { id: "hosts", label: "Git hosts", group: "once" },
  { id: "project", label: "First project", group: "once" },
  { id: "ready", label: "Ready", group: "once" },
];

function Shell(props: {
  current: string;
  heading: string;
  required?: boolean;
  lead: JSX.Element;
  primary: string;
  primaryDisabled?: boolean;
  hint: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <FirstRunShell
      title="Set up Tori"
      rail={
        <StepRail
          steps={STEPS}
          current={props.current}
          reachable={(id) => STEPS.findIndex((s) => s.id === id) < STEPS.findIndex((s) => s.id === props.current)}
          onJump={() => {}}
        />
      }
      railFooter={<span class={styles.railNote}>Agents, base folder and space show on every launch until a space exists.</span>}
      heading={props.heading}
      required={props.required}
      lead={props.lead}
      footerLeft={props.hint}
      footerRight={
        <>
          {props.current !== "agents" && <Button>Back</Button>}
          <Button variant="primary" disabled={props.primaryDisabled}>
            {props.primary}
          </Button>
        </>
      }
    >
      {props.children}
    </FirstRunShell>
  );
}

// No `component`: every story composes the shell with a step, so there are no
// args to control, and a `component` here would make Storybook demand them.
const meta = {
  title: "Panels/FirstRun",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const agent = (id: string, label: string, patch: Partial<AgentHealth>): AgentHealth => ({
  id,
  label,
  program: id,
  status: "notFound",
  signIn: "unknown",
  account: null,
  apiKeySource: null,
  path: null,
  version: null,
  verifiedAgainst: null,
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
  profiles: [],
  ...patch,
});

const npm = (pkg: string): Command => ({ program: "npm", args: ["install", "-g", pkg] });
const INSTALLS: Record<string, Command> = {
  claude: npm("@anthropic-ai/claude-code"),
  codex: npm("@openai/codex"),
  gemini: npm("@google/gemini-cli"),
  opencode: npm("opencode-ai"),
  copilot: npm("@github/copilot"),
};
const LOGINS = ["claude", "codex", "opencode", "copilot"];

const NONE = [
  agent("claude", "Claude", {}),
  agent("codex", "Codex", {}),
  agent("gemini", "Gemini", {}),
  agent("opencode", "OpenCode", {}),
  agent("copilot", "Copilot", {}),
  agent("kimi", "Kimi", {}),
  agent("pi", "Pi", {}),
];

const FOUND = [
  agent("claude", "Claude", { status: "versionMatch", version: "2.1.268", verifiedAgainst: "claude 2.1.231", signIn: "signedIn" }),
  agent("codex", "Codex", { status: "versionMatch", version: "0.147.0", signIn: "signedOut" }),
  agent("opencode", "OpenCode", { status: "versionDrift", version: "1.17.2", verifiedAgainst: "opencode 1.18.3", signIn: "signedIn" }),
  ...NONE.filter((h) => !["claude", "codex", "opencode"].includes(h.id)),
];

const agentsHint = "Not required. Tori opens without an agent.";

function AgentsStory(props: { health: AgentHealth[] | null }) {
  return (
    <Shell current="agents" heading="Agents" lead={AGENTS_LEAD} primary="Continue" hint={agentsHint}>
      <AgentsStep
        health={props.health}
        installs={INSTALLS}
        terminalLogins={LOGINS}
        onInstall={() => {}}
        onSignIn={() => {}}
        onCopy={async () => true}
        onCheckAgain={() => {}}
      />
    </Shell>
  );
}

/** Some installed: sign in where the agent says nobody is. */
export const AgentsFound: Story = {
  render: () => <AgentsStory health={FOUND} />,
};

/** Nothing on PATH: every agent with a declared install can run it here. */
export const AgentsNone: Story = {
  render: () => <AgentsStory health={NONE} />,
};

/** The first probe has not answered. */
export const AgentsChecking: Story = {
  render: () => <AgentsStory health={null} />,
};

const baseHint = "Required. You can change it later in Settings.";

/** Nothing chosen: the primary waits on the picker. */
export const BaseFolderEmpty: Story = {
  render: () => (
    <Shell current="base" heading="Base folder" required lead={BASE_FOLDER_LEAD} primary="Continue" primaryDisabled hint={baseHint}>
      <BaseFolderStep root={null} spaces={[]} home={HOME} onChoose={() => {}} />
    </Shell>
  ),
};

/** A folder that already holds spaces answers the next step as well. */
export const BaseFolderFound: Story = {
  render: () => (
    <Shell current="base" heading="Base folder" required lead={BASE_FOLDER_LEAD} primary="Continue" hint={baseHint}>
      <BaseFolderStep root={ROOT} spaces={SPACES} home={HOME} onChoose={() => {}} />
    </Shell>
  ),
};

/** Chosen, and empty. */
export const BaseFolderVoid: Story = {
  render: () => (
    <Shell current="base" heading="Base folder" required lead={BASE_FOLDER_LEAD} primary="Continue" hint={baseHint}>
      <BaseFolderStep root={`${HOME}/code`} spaces={[]} home={HOME} onChoose={() => {}} />
    </Shell>
  ),
};

const spaceHint = "Required. This is the last step before Tori can open.";

function SpaceStory(props: { spaces: FirstRunSpace[]; mode: SpaceMode }) {
  const [mode, setMode] = createSignal<SpaceMode>(props.mode);
  const [selected, setSelected] = createSignal<string | null>(props.spaces[0]?.name ?? null);
  const [name, setName] = createSignal("");
  const creating = () => mode() === "create" || props.spaces.length === 0;
  return (
    <Shell current="space" heading="Space" required lead={SPACE_LEAD} primary={creating() ? "Create space" : "Continue"} primaryDisabled={creating() && !name().trim()} hint={spaceHint}>
      <SpaceStep
        root={ROOT}
        spaces={props.spaces}
        home={HOME}
        mode={mode()}
        onMode={setMode}
        selected={selected()}
        onSelect={setSelected}
        name={name()}
        onName={setName}
        onSubmit={() => {}}
      />
    </Shell>
  );
}

/** Spaces found: pick the one Tori opens on. */
export const SpaceFound: Story = {
  render: () => <SpaceStory spaces={SPACES} mode="pick" />,
};

/** None found: the field is the only way through. */
export const SpaceCreate: Story = {
  render: () => <SpaceStory spaces={[]} mode="create" />,
};

const OCTOCAT: ForgeHost = {
  host: "github.com",
  accounts: [
    {
      id: "github-com-octocat",
      provider: "github",
      baseUrl: "https://github.com",
      login: "octocat",
      label: "octocat",
      expiresAt: null,
      rejectedAt: null,
      scopes: ["repo", "workflow"],
      source: "token",
      auth: { kind: "signedIn", login: "octocat" },
    },
  ],
  gitCredentials: false,
  gitEverywhere: false,
  defaultAccount: null,
  appId: null,
};

function HostsStory(props: {
  hosts?: ForgeHost[];
  waitingFor?: Cloud;
  failure?: { cloud: Cloud; failure: Failure };
}) {
  return (
    <Shell
      current="hosts"
      heading="Git hosts"
      lead={HOSTS_LEAD}
      primary="Continue"
      hint={<Button variant="ghost">Later</Button>}
    >
      <HostsStep
        hosts={props.hosts ?? []}
        waitingFor={props.waitingFor ?? null}
        failure={props.failure ?? null}
        lifetimeSecs={900}
        wait={
          <DeviceWaitCard
            host={props.waitingFor ?? ""}
            prompt={{ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInSecs: 900, intervalSecs: 5 }}
            remainingMs={14 * 60 * 1000 + 32 * 1000}
            clipboardOk
            onCopyAgain={() => {}}
            onCancel={() => {}}
          />
        }
        onSignIn={() => {}}
      />
    </Shell>
  );
}

/** Nothing signed in yet. */
export const HostsIdle: Story = {
  render: () => <HostsStory />,
};

/** The code is out and the browser is open. */
export const HostsWaiting: Story = {
  render: () => <HostsStory waitingFor="github.com" />,
};

/** Signed in to github.com. */
export const HostsConnected: Story = {
  render: () => <HostsStory hosts={[OCTOCAT]} />,
};

/** The host expired the code before it was entered. */
export const HostsError: Story = {
  render: () => <HostsStory failure={{ cloud: "github.com", failure: { kind: "expired", code: "expired_token" } }} />,
};

const GIT_READY: GitReport = { health: { kind: "ready", path: "/usr/bin/git", version: "2.46.0" }, install: { type: "undeclared" } };
const GIT_MISSING: GitReport = {
  health: { kind: "toolsMissing" },
  install: { type: "terminal", program: "/usr/bin/xcode-select", args: ["--install"] },
};

function ProjectStory(props: { space: FirstRunSpace; git: GitReport }) {
  const [mode, setMode] = createSignal<NewProjectMode>("clone");
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const nothing = () => !name().trim() && !url().trim();
  const cont = () => !!gitMissing(mode(), props.git) || (props.space.projects.length > 0 && nothing());
  return (
    <Shell
      current="project"
      heading="First project"
      lead={PROJECT_LEAD}
      primary={cont() ? "Continue" : PROJECT_LABEL[mode()]}
      primaryDisabled={!cont() && (!name().trim() || (mode() !== "folder" && !url().trim()))}
      hint={<Button variant="ghost">Skip</Button>}
    >
      <ProjectStep
        space={props.space}
        home={HOME}
        mode={mode()}
        onMode={setMode}
        name={name()}
        onName={setName}
        url={url()}
        onUrl={setUrl}
        git={props.git}
        onSubmit={() => {}}
        onInstallGit={() => {}}
        onCheckGit={() => {}}
      />
    </Shell>
  );
}

/** An empty space: pick how the first project arrives. */
export const ProjectIdle: Story = {
  render: () => <ProjectStory space={space("work", 0)} git={GIT_READY} />,
};

/** Clone and worktrees need git; a new folder does not. */
export const ProjectNoGit: Story = {
  render: () => <ProjectStory space={space("work", 0)} git={GIT_MISSING} />,
};

/** The space already has projects, so there is nothing to make. */
export const ProjectFound: Story = {
  render: () => (
    <ProjectStory
      space={{
        ...space("work", 0),
        projects: ["api", "web", "infra", "docs", "sdk-go", "sdk-ts"].map((n) => ({ name: n, path: `${ROOT}/work/${n}` })),
      }}
      git={GIT_READY}
    />
  ),
};

function ReadyStory(props: { summary: ReadySummary }) {
  return (
    <Shell
      current="ready"
      heading="Ready"
      lead={readyLead(props.summary)}
      primary="Open Tori"
      hint={props.summary.hosts.length > 0 ? null : "Nothing was sent anywhere."}
    >
      <ReadyStep summary={props.summary} home={HOME} />
    </Shell>
  );
}

/** Every optional step was taken. */
export const ReadyAllDone: Story = {
  render: () => (
    <ReadyStory
      summary={{
        agents: { found: 3, ready: 2, signedIn: ["Claude", "Codex"] },
        root: ROOT,
        space: { name: "work", created: true },
        hosts: [{ host: "github.com", login: "octocat" }],
        project: { made: "work/api", count: 1 },
      }}
    />
  ),
};

/** No agent, and every optional step skipped. */
export const ReadyAllSkipped: Story = {
  render: () => (
    <ReadyStory
      summary={{
        agents: { found: 0, ready: 0, signedIn: [] },
        root: ROOT,
        space: { name: "work", created: false },
        hosts: [],
        project: { made: null, count: 0 },
      }}
    />
  ),
};
