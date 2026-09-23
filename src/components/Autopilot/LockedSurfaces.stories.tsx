import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For, type JSX } from "solid-js";
import { FileCode } from "lucide-solid";
import Icon from "../Icon/Icon";
import { WorktreeMark } from "../Icon/gitMarks";
import { Tabs } from "../../lib/tabs";
import Tab from "../Tab/Tab";
import { BranchRow } from "../../panels/LeftSidebar/SidebarRows";
import rows from "../../panels/LeftSidebar/SidebarRows.module.css";
import HistoryRow from "../../panels/Terminal/HistoryRow";
import history from "../../panels/Terminal/HistoryPanel.module.css";
import TabMark from "../../panels/Terminal/TabMark";
import Wheel from "./Wheel";
import LockedBar from "./LockedBar";
import { DrivingHairline, DrivingTag, LockMark, StartedMark } from "./SessionMarks";

// Every surface a worker session shows up on, in the three forms it takes: an
// ordinary session, one the autopilot started but no longer drives, and one it
// is driving now, which is locked.

const LOCKED_TIP = "The autopilot is working here. Stop it to close.";

const meta = {
  title: "Autopilot/Locked surfaces",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The tab strip. A locked tab trades its close for the turning wheel, and
 *  Delete, Backspace and a middle click leave it open. */
export const TabStrip: Story = {
  render: () => {
    const [open, setOpen] = createSignal("locked");
    const tabs = [
      { value: "normal", label: "settings.rs", locked: false },
      { value: "started", label: "Cache avatar fetch", locked: false },
      { value: "locked", label: "Fix login redirect loop", locked: true },
    ];
    return (
      <Tabs.Root value={open()} onChange={setOpen}>
        <Tabs.List aria-label="Open tabs" style={{ display: "flex", background: "var(--canvas-head)" }}>
          <For each={tabs}>
            {(t) => (
              <Tab
                value={t.value}
                icon={
                  t.value === "normal" ? (
                    <Icon icon={FileCode} size={13} />
                  ) : (
                    <TabMark agentId="claude" status={t.locked ? "executing" : "idle"} />
                  )
                }
                onClose={() => {}}
                locked={t.locked ? <Wheel state="working" size={12} /> : undefined}
                tooltip={t.locked ? LOCKED_TIP : undefined}
              >
                {t.label}
              </Tab>
            )}
          </For>
        </Tabs.List>
      </Tabs.Root>
    );
  },
};

/** Branch rows in the sidebar: the wheel leads the name, and the lock joins
 *  the end cluster while the autopilot drives the worktree. */
export const SidebarBranchRows: Story = {
  render: () => (
    <div class={rows.rowScope} style={{ width: "260px" }}>
      <BranchRow label="feat/billing" icon={<WorktreeMark active={false} />} />
      <BranchRow
        label="tori/131-avatar-cache"
        icon={<WorktreeMark active={false} />}
        lead={<StartedMark driving={false} />}
      />
      <BranchRow
        label="tori/123-login-redirect"
        icon={<WorktreeMark active />}
        lead={<StartedMark driving />}
        end={<LockMark />}
      />
    </div>
  ),
};

/** Rows in the History dropdown, where the lock takes the timestamp's place. */
export const HistoryRows: Story = {
  render: () => (
    <div
      role="listbox"
      aria-label="Session history"
      style={{ width: "360px", padding: "var(--tori-space-3)", background: "var(--canvas-card)" }}
      class={history.list}
    >
      <HistoryRow label="Tidy the settings pane" agentId="claude" status="idle" when="3h" active={false} items={[]} onOpen={() => {}} />
      <HistoryRow
        label="Cache avatar fetch"
        agentId="claude"
        status="idle"
        when="25m"
        active={false}
        lead={<StartedMark driving={false} />}
        items={[]}
        onOpen={() => {}}
      />
      <HistoryRow
        label="Fix login redirect loop"
        agentId="claude"
        status="executing"
        when="now"
        active
        lead={<StartedMark driving />}
        locked={<LockMark />}
        items={[]}
        onOpen={() => {}}
      />
    </div>
  ),
};

/** The bar that replaces the composer, running and then waiting on an approval. */
export const Bar: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--tori-space-6)", width: "560px" }}>
      <LockedBar now="running pnpm test auth" progress={0.6} />
      <LockedBar now="waiting on your approval to open the PR" progress={1} waiting />
    </div>
  ),
};

const Message = (props: { mine?: boolean; children: JSX.Element }) => (
  <div
    style={{
      "align-self": props.mine ? "flex-end" : "flex-start",
      "max-width": "80%",
      padding: props.mine ? "var(--tori-space-4) var(--tori-space-5)" : "0",
      "border-radius": "var(--tori-radius-xl)",
      background: props.mine ? "var(--neutral-subtle)" : "transparent",
      color: "var(--fg-default)",
      "font-size": "var(--tori-text-md)",
      "line-height": "var(--tori-line-normal)",
    }}
  >
    {props.children}
  </div>
);

/** A chat pane the autopilot is driving: the hairline under the title bar,
 *  the frame, the tag, and the locked bar where the composer was. */
export const DrivenPane: Story = {
  render: () => (
    <div style={{ width: "640px", background: "var(--canvas-default)" }}>
      <div style={{ height: "var(--tori-space-7)", background: "var(--canvas-card)" }} />
      <DrivingHairline />
      <div
        style={{
          position: "relative",
          display: "flex",
          "flex-direction": "column",
          gap: "var(--tori-space-5)",
          height: "360px",
          padding: "var(--tori-space-6)",
          "box-sizing": "border-box",
          background: "var(--canvas-card)",
          border: "var(--tori-border-thin) solid var(--progress-border)",
        }}
      >
        <div style={{ position: "absolute", top: "var(--tori-space-4)", right: "var(--tori-space-4)" }}>
          <DrivingTag />
        </div>
        <div style={{ flex: "1", display: "flex", "flex-direction": "column", "justify-content": "flex-end", gap: "var(--tori-space-5)" }}>
          <Message mine>Work on the login redirect loop, the ticket has the repro.</Message>
          <Message>Reproduced it. The redirect guard reads the session before the cookie refresh lands. Fixing and running the auth tests now.</Message>
        </div>
        <LockedBar now="running pnpm test auth" progress={0.6} />
      </div>
    </div>
  ),
};
