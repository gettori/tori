import type { Meta, StoryObj } from "storybook-solidjs-vite";
import AgentPalette from "./AgentPalette";
import { lockedProvider, type PaletteProvider } from "./agentPaletteData";
import type { Adapter } from "../../utils/agents";
import type { PickableModel } from "../../utils/chatModels";

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

const CLAUDE = lockedProvider(adapter("claude", "Claude"), [
  model("default", "Default", "Whatever the CLI would pick"),
  model("sonnet", "Sonnet 5", "Balanced, the everyday one"),
  model("opus", "Opus 5", "Slowest and strongest"),
  model("haiku", "Haiku 4.5", "Cheap and quick"),
]);

const CODEX = lockedProvider(adapter("codex", "Codex"), [
  model("gpt-5", "GPT-5"),
  model("gpt-5-mini", "GPT-5 mini"),
]);

const SIGNED_OUT: PaletteProvider = {
  ...lockedProvider(adapter("gemini", "Gemini"), [model("gemini-3-pro", "Gemini 3 Pro")]),
  health: { kind: "fix", reason: "Signed out" },
  selectable: false,
};

const PROBING: PaletteProvider = {
  ...lockedProvider(adapter("opencode", "OpenCode"), []),
  health: { kind: "probing" },
};

const meta: Meta<typeof AgentPalette> = {
  title: "Chat/AgentPalette",
  component: AgentPalette,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof AgentPalette>;

/** What a draft opens: every chat-capable agent, in whatever state Sway last
 *  found it, and the models it already knows about. */
export const Draft: Story = {
  args: {
    providers: [CLAUDE, CODEX, SIGNED_OUT, PROBING],
    agentId: "claude",
    value: "sonnet",
    onSelect: () => {},
    onFix: () => {},
    onHighlight: () => {},
    onClose: () => {},
  },
};

/** The same component after the first send. One provider is the whole of the
 *  lock: there is no mode flag and no second code path. */
export const Locked: Story = {
  args: { ...Draft.args, providers: [CLAUDE] },
};
