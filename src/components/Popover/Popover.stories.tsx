import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Show, createSignal } from "solid-js";
import Button from "../Button/Button";
import Popover, { type PopoverPlacement } from "./Popover";

const PLACEMENTS: PopoverPlacement[] = ["bottom-start", "bottom-end", "top-start", "top-end"];

const meta = {
  title: "Components/Popover",
  component: Popover,
  argTypes: {
    placement: { control: "select", options: PLACEMENTS },
  },
  args: {
    placement: "bottom-end",
    onClose: () => {},
    children: null,
  },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Anchored controlled mode, the only mode there is: the opening button belongs
 *  to the caller, which mounts the surface while it is open. Escape, an outside
 *  press, and focus leaving all close it; a press on the button itself is the
 *  button's own toggle rather than a dismissal, so it closes cleanly instead of
 *  reopening in the same gesture. The field is `initialFocus`, and focus goes
 *  back to the button on close. Chrome is split: the wrapper draws the surface,
 *  the caller's own class (here an inline box) owns layout. */
export const Anchored: Story = {
  render: (args) => {
    const [open, setOpen] = createSignal(false);
    let btn: HTMLButtonElement | undefined;
    let field: HTMLInputElement | undefined;
    return (
      <div style={{ padding: "48px", display: "flex", "justify-content": "center" }}>
        <Button ref={btn} onClick={() => setOpen(!open())}>
          Session history
        </Button>
        <Show when={open()}>
          <Popover
            anchorEl={btn}
            placement={args.placement}
            initialFocus={() => field}
            onClose={() => setOpen(false)}
            aria-label="Session history"
          >
            <div
              style={{
                width: "280px",
                padding: "var(--tori-space-4)",
                display: "flex",
                "flex-direction": "column",
                gap: "var(--tori-space-3)",
              }}
            >
              <input
                ref={field}
                type="text"
                placeholder="Search sessions"
                aria-label="Search sessions"
              />
              <div style={{ color: "var(--fg-muted)", "font-size": "var(--tori-text-sm)" }}>
                The wrapper draws the surface; this box is the caller's layout.
              </div>
            </div>
          </Popover>
        </Show>
      </div>
    );
  },
};
