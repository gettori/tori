import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import IconButton from "../IconButton/IconButton";
import Tooltip, { type TooltipPlacement } from "./Tooltip";

const PLACEMENTS: TooltipPlacement[] = ["top", "bottom", "left", "right"];

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  argTypes: {
    placement: { control: "select", options: PLACEMENTS },
    label: { control: "text" },
    openDelay: { control: "number" },
    closeDelay: { control: "number" },
    whenDisabled: { control: "boolean" },
  },
  args: {
    label: "Split the editor to the right",
    placement: "top",
    as: "button",
    children: "Split",
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every prop live in the controls panel. Hover the button, then Tab to it: a
 *  native `title` answers only the first of those, which is the whole reason
 *  this component exists. */
export const Playground: Story = {};

/** The four sides. `top` is the default and the right answer for a toolbar row;
 *  `right` is for a vertical rail, where a tooltip above would cover the
 *  neighbour above it. Kobalte flips a placement that would leave the viewport,
 *  so these are preferences rather than promises - drag the preview narrow and
 *  `left` becomes `right` on its own. */
export const Placements: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-8)", padding: "80px" }}>
      <For each={PLACEMENTS}>
        {(placement) => (
          <Tooltip label={`Opens on the ${placement}`} placement={placement} as="button">
            {placement}
          </Tooltip>
        )}
      </For>
    </div>
  ),
};

/** The delay, and the grouping that makes a row of them usable.
 *
 *  The first tooltip takes 700ms to appear. Move the pointer straight to the
 *  next button and the next one appears instantly: within 300ms of one closing,
 *  the group is "warm" and the delay is skipped, so sweeping the row reads as
 *  one gesture rather than eight separate waits. Pause for a second between two
 *  buttons and the delay comes back.
 *
 *  The timer behind that is module-global inside the primitives library, so the
 *  grouping is a property of the whole app, not of this row. */
export const DelayAndGrouping: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-2)", padding: "80px" }}>
      <For each={["Save", "Format", "Run", "Debug", "Split", "Close"]}>
        {(action) => (
          <Button tooltip={`${action} the current file`}>{action}</Button>
        )}
      </For>
    </div>
  ),
};

/** An icon-only control, where the tooltip is also the accessible name. There is
 *  no visible text, so `Button` and `IconButton` backfill `aria-label` from
 *  `tooltip` - inspect the button and the name is there without the call site
 *  having written it twice. */
export const OnAnIconButton: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-2)", padding: "80px" }}>
      <For each={["Split right", "Split down", "Close others"]}>
        {(label) => (
          <IconButton
            tooltip={label}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            }
          />
        )}
      </For>
    </div>
  ),
};

/** Inside a modal dialog, where the tooltip has to portal into the panel.
 *
 *  A modal aria-hides the whole document except its own panel, so a tooltip
 *  portalled onto the body would be painted on screen and absent from the
 *  accessibility tree at once - visibly fine and silently broken. The dialog
 *  publishes its panel and the tooltip mounts into it, so nothing is needed
 *  here beyond putting a tooltipped button in a dialog. */
export const InsideADialog: Story = {
  render: () => (
    <Dialog
      open
      title="Commit"
      description="Two of the three staged files are new."
      onClose={() => {}}
      actions={
        <>
          <Button tooltip="Leave the index as it is">Cancel</Button>
          <Button variant="primary" tooltip="Commit the three staged files">
            Commit
          </Button>
        </>
      }
    >
      Committing to `feature/tooltips`.
    </Dialog>
  ),
};

/** The opt-in for a `disabled` control, and the one story that has to be judged
 *  by hand.
 *
 *  A disabled button fires no pointer events at all, so its tooltip is
 *  unreachable by any means - and it is exactly the button whose tooltip
 *  explains *why* it is disabled. `tooltipWhenDisabled` wraps it in a hover
 *  surface that can. Hover both: the plain one stays silent, the opted-in one
 *  explains itself.
 *
 *  It is off by default because that span changes the DOM shape at the call
 *  site, and it is opted into per site because "the label explains the disabled
 *  state" is a judgement no check in this repo can make. */
export const WhenDisabled: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-4)", padding: "80px" }}>
      <Button disabled tooltip="Nothing staged to commit">
        Commit (plain)
      </Button>
      <Button disabled tooltipWhenDisabled tooltip="Nothing staged to commit">
        Commit (reachable)
      </Button>
    </div>
  ),
};

/** A label longer than the 280px cap, which wraps rather than clipping. The
 *  tooltips carrying a full path or a branch name are the ones that reach it. */
export const LongLabel: Story = {
  args: {
    label:
      "src/panels/Editor/PullRequests/ReviewBar.module.css - modified on feature/tooltips, 3 commits behind main",
    children: "ReviewBar.module.css",
  },
};
