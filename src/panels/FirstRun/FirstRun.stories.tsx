import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, type JSX } from "solid-js";
import Button from "../../components/Button/Button";
import type { FirstRunSpace } from "../../utils/firstRun";
import FirstRunShell, { StepRail, type RailStep } from "./FirstRunShell";
import BaseFolderStep, { BASE_FOLDER_LEAD } from "./steps/BaseFolderStep";
import ReadyStep, { readyLead } from "./steps/ReadyStep";
import SpaceStep, { SPACE_LEAD, type SpaceMode } from "./steps/SpaceStep";
import styles from "./FirstRun.module.css";

const HOME = "/Users/rowan";
const ROOT = `${HOME}/Projects`;
const space = (name: string, n: number): FirstRunSpace => ({
  name,
  path: `${ROOT}/${name}`,
  external: false,
  projects: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, path: `${ROOT}/${name}/p${i}` })),
});
const SPACES = [space("work", 6), space("personal", 5), space("acme", 3)];

const STEPS: RailStep[] = [
  { id: "base", label: "Base folder", required: true, group: "setup", summary: "~/Projects" },
  { id: "space", label: "Space", required: true, group: "setup", summary: "work" },
  { id: "ready", label: "Ready", group: "setup" },
];

function Shell(props: {
  current: string;
  heading: string;
  required?: boolean;
  lead: JSX.Element;
  primary: string;
  primaryDisabled?: boolean;
  hint: string;
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
      railFooter={<span class={styles.railNote}>Base folder and space show on every launch until a space exists.</span>}
      heading={props.heading}
      required={props.required}
      lead={props.lead}
      footerLeft={props.hint}
      footerRight={
        <>
          {props.current !== "base" && <Button>Back</Button>}
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

/** The summary before Tori opens. */
export const Ready: Story = {
  render: () => {
    const summary = { root: ROOT, space: { name: "work", created: true } };
    return (
      <Shell current="ready" heading="Ready" lead={readyLead(summary)} primary="Open Tori" hint="Nothing was sent anywhere.">
        <ReadyStep summary={summary} home={HOME} />
      </Shell>
    );
  },
};
