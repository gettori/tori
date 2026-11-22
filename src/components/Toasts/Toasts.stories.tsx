import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import Button from "../Button/Button";
import ToastRegion, { clearToasts, pushToast } from "./Toasts";

// The toast store is module-global and outlives any one Region, so an autodocs
// page rendering several stories at once would otherwise show each toast in
// every story's region. Clearing on mount keeps a story showing its own.
const meta = {
  title: "Components/Toasts",
  component: ToastRegion,
  decorators: [
    (Story) => {
      clearToasts();
      return <Story />;
    },
  ],
} satisfies Meta<typeof ToastRegion>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed into a deck: the newest in front, the two before it showing a
 *  strip above. Hover the deck, or Tab into it, to fan it out; Escape closes
 *  the focused toast. The error stays until closed, the notice dismisses itself
 *  after 8 seconds unless the deck is hovered or focused. ⌘⌥T moves focus into
 *  the deck in the app, where the command registry owns that key. */
export const Stack: Story = {
  render: () => {
    onSettled(() => {
      pushToast("Could not remove the worktree: it has uncommitted changes.", "error");
      pushToast("Pulled.", "success");
      pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} });
    });
    return (
      <Backdrop>
        <ToastRegion />
      </Backdrop>
    );
  },
};

// setTimeout fires at once for any delay past 2^31-1 ms, Infinity included.
const HELD = 2 ** 31 - 1;

/** Stands in for the panes, since how well a toast separates from them is the
 *  point. Use the toolbar's Theme menu to check each palette. */
function Backdrop(props: { children: JSX.Element }) {
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
      {props.children}
    </div>
  );
}

/** One of each shape, held on screen. Hover the deck to compare them fanned
 *  out: an error, one that wraps, a success with an action, a notice, and a
 *  notice with Undo. */
export const Gallery: Story = {
  render: () => {
    onSettled(() => {
      pushToast("Push rejected: the remote moved.", "error");
      pushToast(
        "git fetch failed:\nfatal: unable to access 'https://github.com/gettori/tori/': Could not resolve host",
        "error",
      );
      pushToast("Setup finished in tori-toast", "success", { label: "Show log", run: () => {} });
      pushToast("Branch attached", "info");
      pushToast("Renamed 12 files", "info", { label: "Undo", run: () => {} });
    });
    return (
      <Backdrop>
        <ToastRegion duration={HELD} />
      </Backdrop>
    );
  },
};

/** More than the fanned-out deck shows. The newest five fan out; the rest wait
 *  until one of those closes. Clear all appears above the deck while it is
 *  fanned out. */
export const Overflow: Story = {
  render: () => {
    onSettled(() => {
      for (let i = 1; i <= 8; i++) pushToast(`Push ${i} rejected: the remote moved.`, "error");
    });
    return (
      <Backdrop>
        <ToastRegion />
      </Backdrop>
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
