import type { Meta, StoryObj } from "storybook-solidjs-vite";
import InlineJobFrame, { StaticOutput, type JobState } from "./InlineJobFrame";

const INSTALL = ["added 3 packages in 4s", "", "2 packages are looking for funding", "  run `npm fund` for details"];

const LOGIN = [
  "Opening https://auth.openai.com/oauth/authorize in your browser.",
  "",
  "If the browser did not open, visit the URL above.",
  "Paste the code from the browser:",
];

const CLONE_FAIL = [
  "Cloning into 'api'...",
  "git@github.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
  "",
  "Please make sure you have the correct access rights",
  "and the repository exists.",
];

function Frame(props: {
  state: JobState;
  command: string;
  lines: string[];
  code?: number | null;
  okLine: string;
  title: string;
}) {
  return (
    <div style={{ padding: "var(--tori-space-7)", background: "var(--canvas-card)", "min-height": "100vh" }}>
      <InlineJobFrame
        command={props.command}
        state={props.state}
        code={props.code}
        okLine={props.okLine}
        failLine={`${props.title} did not finish. The output above says why.`}
        onCancel={() => {}}
        onRetry={() => {}}
      >
        <StaticOutput lines={props.lines} />
      </InlineJobFrame>
    </div>
  );
}

// No `component`: the frame's body is a slot, which Storybook cannot build
// from args.
const meta = {
  title: "Panels/FirstRun/InlineJob",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Running: Story = {
  render: () => (
    <Frame
      state="running"
      command="npm install -g @anthropic-ai/claude-code"
      lines={INSTALL.slice(0, 1)}
      okLine="Claude installed"
      title="Install Claude"
    />
  ),
};

export const NeedsInput: Story = {
  render: () => (
    <Frame
      state="waiting"
      command="codex login"
      lines={LOGIN}
      okLine="Signed in to Codex"
      title="Sign in to Codex (Default)"
    />
  ),
};

/** Collapsed to one row; Show output restores the body with a footer. */
export const Succeeded: Story = {
  render: () => (
    <Frame
      state="ok"
      command="npm install -g @anthropic-ai/claude-code"
      lines={INSTALL}
      okLine="Claude installed"
      title="Install Claude"
    />
  ),
};

export const Failed: Story = {
  render: () => (
    <Frame
      state="fail"
      code={128}
      command="git clone git@github.com:acme/api.git"
      lines={CLONE_FAIL}
      okLine="Cloned"
      title="Clone api"
    />
  ),
};
