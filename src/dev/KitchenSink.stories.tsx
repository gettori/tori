import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For, Show, createSignal, type JSX } from "solid-js";
import { Copy, PanelLeft, Settings, Trash2 } from "lucide-solid";
import Button, { type ButtonSize, type ButtonVariant } from "../components/Button/Button";
import Checkbox from "../components/Checkbox/Checkbox";
import CheckboxGroup from "../components/CheckboxGroup/CheckboxGroup";
import Dialog from "../components/Dialog/Dialog";
import Icon from "../components/Icon/Icon";
import IconButton from "../components/IconButton/IconButton";
import ContextMenu from "../components/Menu/ContextMenu";
import Dropdown from "../components/Menu/Dropdown";
import { MenuRow, MenuSeparator, MenuSub } from "../components/Menu/rows";
import Popover from "../components/Popover/Popover";
import RadioGroup from "../components/RadioGroup/RadioGroup";
import Select from "../components/Select/Select";
import Tooltip from "../components/Tooltip/Tooltip";
import {
  ChatInput,
  FILE_1,
  IMAGE_1,
  PR_CHIP,
  chatInputHost,
  stubAssetUrls,
} from "../panels/Chat/__fixtures__/chatInput";
import { PromptsPane, createPrompts, promptsHost } from "../panels/Chat/__fixtures__/prompts";
import { TranscriptPane, createTranscript } from "../panels/Chat/__fixtures__/transcript";
import patterns from "../styles/patterns.module.css";
import { enterOnce } from "../utils/enterOnce";
import { stubHost } from "./stubHost";

const VARIANTS: ButtonVariant[] = ["default", "primary", "success", "warn", "danger", "ghost"];
const SIZES: ButtonSize[] = ["md", "sm", "xs"];

const row: JSX.CSSProperties = {
  display: "flex",
  "flex-wrap": "wrap",
  "align-items": "center",
  gap: "var(--tori-space-4)",
};

function Section(props: { title: string; note: string; children: JSX.Element }) {
  return (
    <section
      style={{
        display: "grid",
        gap: "var(--tori-space-5)",
        padding: "var(--tori-space-7) 0",
        "border-top": "1px solid var(--border-default)",
      }}
    >
      <header style={{ display: "grid", gap: "var(--tori-space-2)" }}>
        <h2 style={{ margin: 0, "font-size": "var(--tori-text-3xl)", color: "var(--fg-default)" }}>{props.title}</h2>
        <p style={{ margin: 0, "font-size": "var(--tori-text-md)", color: "var(--fg-muted)" }}>{props.note}</p>
      </header>
      {props.children}
    </section>
  );
}

const ENTRANCES = { pop: patterns.enterPop, rise: patterns.enterRise };
type Entrance = keyof typeof ENTRANCES;

function Probe(props: { id: number; enter: Entrance }) {
  const [plays, setPlays] = createSignal(0);
  return (
    <div
      ref={(el) => enterOnce(el, ENTRANCES[props.enter])}
      onAnimationStart={() => setPlays(plays() + 1)}
      style={{
        padding: "var(--tori-space-4) var(--tori-space-5)",
        border: "1px solid var(--border-default)",
        "border-radius": "var(--tori-radius-md)",
        background: "var(--canvas-card)",
        "font-size": "var(--tori-text-md)",
        color: "var(--fg-default)",
      }}
    >
      #{props.id} {props.enter}, played {plays()}
    </div>
  );
}

function MotionSection() {
  const [hidden, setHidden] = createSignal(false);
  const [probes, setProbes] = createSignal<Entrance[]>(["pop", "rise"]);
  return (
    <Section
      title="Motion"
      note="Each probe counts how often its entrance played. Hide and show replays nothing; a probe added while hidden never plays."
    >
      <div style={row}>
        <Button onClick={() => setProbes([...probes(), "pop"])}>Add pop</Button>
        <Button onClick={() => setProbes([...probes(), "rise"])}>Add rise</Button>
        <Button variant="ghost" onClick={() => setHidden(!hidden())}>
          {hidden() ? "Show" : "Hide"} (display: none)
        </Button>
      </div>
      <div style={{ ...row, display: hidden() ? "none" : "flex" }}>
        <For each={probes()}>{(enter, i) => <Probe id={i() + 1} enter={enter} />}</For>
      </div>
    </Section>
  );
}

function ComposerSection() {
  const [hidden, setHidden] = createSignal(false);
  return (
    <Section
      title="Composer"
      note="Idle: type to light the send button, @ opens the list, picking a row attaches it. Running: Option+Enter queues, and a tile shows its X on hover. Hide and show replays nothing."
    >
      <div style={row}>
        <Button variant="ghost" onClick={() => setHidden(!hidden())}>
          {hidden() ? "Show" : "Hide"} (display: none)
        </Button>
      </div>
      <div style={{ display: hidden() ? "none" : "grid", gap: "var(--tori-space-5)" }}>
        <ChatInput height="320px" />
        <ChatInput height="420px" running attachments={[IMAGE_1, FILE_1, PR_CHIP]} />
      </div>
    </Section>
  );
}

function TranscriptSection() {
  const transcript = createTranscript();
  const [collapse, setCollapse] = createSignal(false);
  const [hidden, setHidden] = createSignal(false);
  return (
    <Section
      title="Transcript"
      note="Send prompts or run an agent turn and the new rows rise in. History, Load earlier, a lane chip, Collapse work, the first row of an empty chat and hide then show draw rows without rising. The status and lane dots pulse while a turn runs."
    >
      <div style={row}>
        <Button onClick={() => transcript.sendOrSteer()}>{transcript.running() ? "Steer" : "Send a prompt"}</Button>
        <Button onClick={() => transcript.runAgentTurn()} disabled={transcript.running()}>
          Run an agent turn
        </Button>
        <Button onClick={() => transcript.deliverHistory()} disabled={!transcript.moreHistory()}>
          Deliver history
        </Button>
        <Button variant="ghost" onClick={() => setCollapse(!collapse())}>
          {collapse() ? "Expand work" : "Collapse work"}
        </Button>
        <Button variant="ghost" onClick={() => transcript.reset()}>
          Empty the chat
        </Button>
        <Button variant="ghost" onClick={() => setHidden(!hidden())}>
          {hidden() ? "Show" : "Hide"} (display: none)
        </Button>
      </div>
      <div style={{ display: hidden() ? "none" : "block", border: "1px solid var(--border-default)" }}>
        <TranscriptPane transcript={transcript} collapseWork={collapse()} height="520px" />
      </div>
    </Section>
  );
}

function PromptsSection() {
  const prompts = createPrompts();
  return (
    <Section
      title="Prompts"
      note="A permission prompt on an edit and on a long command, then two approval asks, a long draft and a short one. A pressed option holds a neutral fill until the ask clears; a failed answer gives the buttons back."
    >
      <div style={row}>
        <Button onClick={() => prompts.askAgain()}>Ask again</Button>
        <Button variant="ghost" onClick={() => prompts.setFailNext(true)} disabled={prompts.failNext()}>
          {prompts.failNext() ? "The next answer fails" : "Fail the next answer"}
        </Button>
      </div>
      <PromptsPane prompts={prompts} />
      <p style={{ margin: 0, "font-size": "var(--tori-text-md)", color: "var(--fg-muted)" }}>
        Host heard: {prompts.heard().slice(-3).join(" / ") || "nothing yet"}
      </p>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section title="Buttons" note="Every variant and size, the icon buttons, and disabled ones that must not move.">
      <For each={SIZES}>
        {(size) => (
          <div style={row}>
            <For each={VARIANTS}>
              {(variant) => (
                <Button variant={variant} size={size}>
                  {variant}
                </Button>
              )}
            </For>
            <Button size={size} disabled>
              disabled
            </Button>
          </div>
        )}
      </For>
      <div style={row}>
        <Button icon={<Icon icon={Settings} />}>Settings</Button>
        <For each={SIZES}>
          {(size) => <IconButton size={size} icon={<Icon icon={Copy} />} tooltip={`Copy (${size})`} />}
        </For>
        <IconButton icon={<Icon icon={PanelLeft} />} tooltip="Sidebar (active)" active />
        <IconButton icon={<Icon icon={Trash2} />} tooltip="Delete (disabled)" disabled />
      </div>
    </Section>
  );
}

const DENSITY = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
  { value: "dense", label: "Dense", disabled: true },
];

function OverlaysSection() {
  const [density, setDensity] = createSignal("comfortable");
  const [popover, setPopover] = createSignal(false);
  const [dialog, setDialog] = createSignal(false);
  let popoverBtn: HTMLButtonElement | undefined;
  return (
    <Section
      title="Overlays"
      note="Dropdown with a submenu and a danger row, a right-click menu, a select, a popover, a tooltip and a dialog."
    >
      <div style={row}>
        <Dropdown
          as="span"
          wrapper
          menu={
            <>
              <MenuRow onClick={() => {}}>New session</MenuRow>
              <MenuRow onClick={() => {}}>Commit log</MenuRow>
              <MenuSub label="Open in">
                <MenuRow onClick={() => {}}>Editor</MenuRow>
                <MenuRow onClick={() => {}}>Terminal</MenuRow>
              </MenuSub>
              <MenuRow onClick={() => {}} disabled>
                Push (no upstream)
              </MenuRow>
              <MenuSeparator />
              <MenuRow onClick={() => {}} danger>
                Remove worktree
              </MenuRow>
            </>
          }
        >
          <Button>Actions</Button>
        </Dropdown>
        <ContextMenu
          style={{
            padding: "var(--tori-space-3) var(--tori-space-4)",
            border: "1px dashed var(--border-default)",
            "border-radius": "var(--tori-radius-md)",
            color: "var(--fg-default)",
          }}
          items={[
            { label: "Rename", onClick: () => {} },
            { label: "Reveal in Finder", onClick: () => {} },
            { separator: true },
            { label: "Delete", onClick: () => {}, danger: true },
          ]}
        >
          Right-click me
        </ContextMenu>
        <Select options={DENSITY} value={density()} onChange={setDensity} aria-label="Transcript density" />
        <Button ref={popoverBtn} onClick={() => setPopover(!popover())}>
          Session history
        </Button>
        <Show when={popover()}>
          <Popover
            anchorEl={popoverBtn}
            placement="bottom-start"
            onClose={() => setPopover(false)}
            aria-label="Session history"
          >
            <div style={{ width: "240px", padding: "var(--tori-space-4)", color: "var(--fg-muted)" }}>
              Popover body.
            </div>
          </Popover>
        </Show>
        <Tooltip label="Split the editor to the right" as={Button}>
          Hover for a tooltip
        </Tooltip>
        <Button variant="primary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <Dialog
          open={dialog()}
          onClose={() => setDialog(false)}
          title="Delete branch"
          description="This cannot be undone."
          actions={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Delete
              </Button>
            </>
          }
        >
          Delete `feature/omnibox` and everything on it?
        </Dialog>
      </div>
    </Section>
  );
}

function ChecksSection() {
  const [untracked, setUntracked] = createSignal(false);
  const [picks, setPicks] = createSignal<string[]>([]);
  const [place, setPlace] = createSignal<string | null>(null);
  return (
    <Section title="Checks" note="Tick and dot, checked and unchecked, plus disabled states.">
      <div style={{ display: "grid", gap: "var(--tori-space-8)", "grid-template-columns": "repeat(3, max-content)" }}>
        <div style={{ display: "grid", gap: "var(--tori-space-3)", "align-content": "start" }}>
          <Checkbox checked={untracked()} onChange={setUntracked} label="Include untracked files" />
          <Checkbox checked={false} onChange={() => {}} label="Disabled" disabled />
          <Checkbox checked onChange={() => {}} label="Disabled and checked" disabled />
        </div>
        <CheckboxGroup
          label="Which should I address?"
          value={picks()}
          onChange={setPicks}
          options={[
            { value: "check", label: "Add the guard" },
            { value: "comment", label: "Comment the coupling" },
            { value: "leave", label: "Leave it", disabled: true },
          ]}
        />
        <RadioGroup
          label="Where should it render?"
          value={place()}
          onChange={setPlace}
          options={[
            { value: "inline", label: "Inline" },
            { value: "modal", label: "Modal" },
            { value: "sheet", label: "Sheet", disabled: true },
          ]}
        />
      </div>
    </Section>
  );
}

function KitchenSink() {
  stubHost([chatInputHost, promptsHost]);
  stubAssetUrls();
  return (
    <div style={{ "max-width": "960px", padding: "0 var(--tori-space-7)" }}>
      <MotionSection />
      <ButtonsSection />
      <OverlaysSection />
      <ChecksSection />
      <ComposerSection />
      <TranscriptSection />
      <PromptsSection />
    </div>
  );
}

const meta = {
  title: "Design/Kitchen sink",
  component: KitchenSink,
} satisfies Meta<typeof KitchenSink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Polish: Story = {};
