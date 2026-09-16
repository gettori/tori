import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { onMount } from "solid-js";
import Button from "../Button/Button";
import { Toast } from "../../lib/toast";
import ToastRegion, { pushToast } from "./Toasts";

// The toast store is module-global and outlives any one Region, so an autodocs
// page rendering several stories at once would otherwise show each toast in
// every story's region. Clearing on mount keeps a story showing its own.
const meta = {
  title: "Components/Toasts",
  component: ToastRegion,
  decorators: [
    (Story) => {
      Toast.toaster.clear();
      return <Story />;
    },
  ],
} satisfies Meta<typeof ToastRegion>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The two kinds, stacked newest at the bottom. Each dismisses itself after 8
 *  seconds; hovering or focusing the stack holds them, and Escape closes the
 *  focused one. ⌘⌥T moves focus into the stack in the app, where the command
 *  registry owns that key - here there is no registry, so use Tab. */
export const Stack: Story = {
  render: () => {
    onMount(() => {
      pushToast("Could not remove the worktree: it has uncommitted changes.", "error");
      pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} });
    });
    return <ToastRegion />;
  },
};

/** Pushed on demand, which is how the app uses it: every toast in Tori arrives
 *  through `pushToast` or the TOAST event, never as a prop. */
export const Interactive: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-3)", padding: "48px" }}>
      <Button variant="danger" onClick={() => pushToast("Push rejected: the remote moved.", "error")}>
        Raise an error
      </Button>
      <Button onClick={() => pushToast("Branch attached", "info")}>Raise a notice</Button>
      <Button
        onClick={() =>
          pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} })
        }
      >
        Raise one with an action
      </Button>
      <ToastRegion />
    </div>
  ),
};
