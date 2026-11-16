import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For, Show, createSignal, type JSX } from "solid-js";
import { Copy, PanelLeft, Settings, Trash2 } from "lucide-solid";
import Button, { type ButtonSize, type ButtonVariant } from "../components/Button/Button";
import Checkbox from "../components/Checkbox/Checkbox";
import CheckboxGroup from "../components/CheckboxGroup/CheckboxGroup";
import Dialog from "../components/Dialog/Dialog";
import Glide, { optionAt } from "../components/Glide/Glide";
import Icon from "../components/Icon/Icon";
import IconButton from "../components/IconButton/IconButton";
import ContextMenu from "../components/Menu/ContextMenu";
import Dropdown from "../components/Menu/Dropdown";
import { MenuRow, MenuSeparator, MenuSub } from "../components/Menu/rows";
import Popover from "../components/Popover/Popover";
import RadioGroup from "../components/RadioGroup/RadioGroup";
import Select from "../components/Select/Select";
import SelectionToolbar, { quoteAction, readAction } from "../components/SelectionToolbar/SelectionToolbar";
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

function Section(props: { heading: string; note: string; children: JSX.Element }) {
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
        <h2 style={{ margin: 0, "font-size": "var(--tori-text-3xl)", color: "var(--fg-default)" }}>{props.heading}</h2>
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
      heading="Motion"
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
      heading="Composer"
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
      heading="Transcript"
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
      heading="Prompts"
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

function SelectionSection() {
  let root: HTMLDivElement | undefined;
  const [heard, setHeard] = createSignal("");
  const said = (label: string) => (text: string) => setHeard(`${label}: ${text.slice(0, 60)}`);
  return (
    <Section
      heading="Selection"
      note="Select some text: the toolbar pops in once under it, an action fills inside the pill on hover and settles on press. Where it sits and what it offers are unchanged."
    >
      <div
        ref={root}
        style={{
          display: "grid",
          gap: "var(--tori-space-4)",
          "font-size": "var(--tori-text-lg)",
          "line-height": 1.6,
          color: "var(--fg-default)",
        }}
      >
        <p style={{ margin: 0 }}>
          Select a few words in either paragraph and the toolbar floats under the selection. Pressing an action keeps
          the selection, so the text you picked is the text the action gets.
        </p>
        <p style={{ margin: 0 }}>
          Quote puts the selection in the composer as a Markdown quote, and Read speaks it with the local voice.
        </p>
      </div>
      <SelectionToolbar root={() => root} actions={[quoteAction(said("Quote")), readAction(said("Read"))]} />
      <p style={{ margin: 0, "font-size": "var(--tori-text-md)", color: "var(--fg-muted)" }}>
        Last action: {heard() || "none yet"}
      </p>
    </Section>
  );
}

const PATHS = Array.from({ length: 40 }, (_, i) =>
  [
    "src/panels/Chat/Composer.tsx",
    "src/panels/Chat/MessageList.tsx",
    "src/components/Menu/rows.tsx",
    "src/components/Select/Select.tsx",
    "src/utils/enterOnce.ts",
  ][i % 5].replace(".ts", `${Math.floor(i / 5) || ""}.ts`),
);

const listBox: JSX.CSSProperties = {
  position: "relative",
  isolation: "isolate",
  display: "flex",
  "flex-direction": "column",
  "max-height": "calc(240px * var(--ui-scale))",
  "overflow-y": "auto",
  padding: "calc(4px * var(--ui-scale))",
  background: "var(--canvas-card)",
  border: "1px solid var(--border-default)",
  "border-radius": "var(--tori-radius-md)",
  "box-shadow": "var(--shadow-md)",
};

const listRow: JSX.CSSProperties = {
  padding: "calc(5px * var(--ui-scale)) calc(10px * var(--ui-scale))",
  border: 0,
  background: "transparent",
  color: "var(--fg-default)",
  "font-family": "var(--tori-font-mono)",
  "font-size": "var(--tori-text-md)",
  "text-align": "left",
  cursor: "pointer",
};

function ListsSection() {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [open, setOpen] = createSignal(true);
  const rows = () => PATHS.filter((p) => p.toLowerCase().includes(query().toLowerCase()));
  const step = (by: number) => {
    const n = rows().length;
    if (n) setIndex((i) => (i + by + n) % n);
  };
  return (
    <Section
      heading="Lists"
      note="The fill glides under a moving pointer and jumps with the arrows. Wheel under a still pointer and it stays on the row beneath it; filter and it follows the active row; reopen and it lands while the list is still scaling in. The right list lights only under the pointer and is hidden, observing nothing, when the pointer is away."
    >
      <div style={row}>
        <input
          aria-label="Filter paths"
          placeholder="Filter, arrows to move"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), step(1));
            if (e.key === "ArrowUp") (e.preventDefault(), step(-1));
          }}
          style={{ width: "calc(260px * var(--ui-scale))" }}
          class={patterns.input}
        />
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        <Button onClick={() => setOpen(true)}>Open</Button>
      </div>
      <div
        style={{
          display: "grid",
          "grid-template-columns": "1fr 1fr",
          gap: "var(--tori-space-5)",
          "align-items": "start",
        }}
      >
        <Show when={open()} fallback={<div />}>
          <div
            ref={(el) => enterOnce(el, patterns.enterPop)}
            role="listbox"
            aria-label="Paths"
            style={{ ...listBox, "transform-origin": "top center", "--glide-radius": "var(--tori-radius-sm)" }}
          >
            <Glide active={(list) => optionAt(list, index())} />
            <For each={rows()}>
              {(path, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i() === index()}
                  onMouseEnter={() => setIndex(i())}
                  style={listRow}
                >
                  {path}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div role="listbox" aria-label="Hover only" style={listBox}>
          <Glide hover='[role="option"]' />
          <For each={PATHS.slice(0, 6)}>
            {(path) => (
              <div role="option" aria-selected="false" style={listRow}>
                {path}
              </div>
            )}
          </For>
        </div>
      </div>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section heading="Buttons" note="Every variant and size, the icon buttons, and disabled ones that must not move.">
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
      heading="Overlays"
      note="Dropdown with a submenu and a danger row, a right-click menu, a select, a popover, a tooltip and a dialog. In the menus and the select one fill glides under the pointer and jumps with the arrows; a disabled row takes none, the danger row keeps its own wash, and the submenu's parent stays lit while the pointer is in the flyout."
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
    <Section heading="Checks" note="Tick and dot, checked and unchecked, plus disabled states.">
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
    // Its own scroller: App.css locks `html` and `body`, which suits a window but
    // not a page this long.
    <div style={{ position: "fixed", inset: 0, "overflow-y": "auto", padding: "var(--tori-space-6)" }}>
      <div style={{ "max-width": "960px", padding: "0 var(--tori-space-7)" }}>
        <MotionSection />
        <ButtonsSection />
        <OverlaysSection />
        <ChecksSection />
        <ComposerSection />
        <TranscriptSection />
        <PromptsSection />
        <SelectionSection />
        <ListsSection />
      </div>
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
