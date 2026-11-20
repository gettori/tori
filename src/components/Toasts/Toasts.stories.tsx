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

/** The kinds, stacked newest at the bottom. Each dismisses itself after 8
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

// setTimeout fires at once for any delay past 2^31-1 ms, Infinity included.
const HELD = 2 ** 31 - 1;

/** Every variant at once, held on screen so they can be compared. Use the
 *  toolbar's Theme menu to check each palette. The backdrop stands in for the
 *  panes, since how well a toast separates from them is the point. */
export const Gallery: Story = {
  render: () => {
    onMount(() => {
      pushToast("Push rejected: the remote moved.", "error");
      pushToast("Could not remove the worktree: it has uncommitted changes.", "error", {
        label: "Force",
        run: () => {},
      });
      pushToast(
        "git fetch failed:\nfatal: unable to access 'https://github.com/gettori/tori/': Could not resolve host",
        "error",
      );
      pushToast("Pulled.", "success");
      pushToast("Setup finished in tori-toast", "success", { label: "Show log", run: () => {} });
      pushToast("Branch attached", "info");
      pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} });
    });
    return (
      <div
        style={{
          position: "fixed",
          inset: "0",
          display: "grid",
          "grid-template-columns": "240px 1fr",
          background: "var(--canvas-default)",
        }}
      >
        <div style={{ background: "var(--canvas-card)", "border-right": "1px solid var(--border-default)" }} />
        <div style={{ padding: "24px", color: "var(--fg-muted)", "font-family": "var(--tori-font-mono)" }}>
          {Array.from({ length: 40 }, (_, i) => (
            <div>{`${String(i + 1).padStart(3)}  const value = compute(input, options);`}</div>
          ))}
        </div>
        <ToastRegion duration={HELD} />
      </div>
    );
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
      <Button onClick={() => pushToast("Pushed tori-toast.", "success")}>Raise a success</Button>
      <Button onClick={() => pushToast("Branch attached", "info")}>Raise a notice</Button>
      <Button onClick={() => pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} })}>
        Raise one with an action
      </Button>
      <ToastRegion />
    </div>
  ),
};
