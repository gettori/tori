import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";

// Two modal dialogs open at once, which the migration onto `Dialog` (#99) makes
// reachable in a way it was not before. `AskpassDialog` is mounted app-wide and
// a backgrounded fetch can raise `askpass://prompt` at any moment, including
// while a `ConfirmDialog` is up. Before the migration those were two independent
// portals sharing nothing; now they are two Kobalte focus scopes and two
// dismiss layers stacked on each other.
//
// This is a characterization: it pins what the stack actually does, in the
// order a user would hit it.
//
// The accessibility assertion at the bottom carries the one measured surprise.
// Once the stack settles, the covered panel is aria-hidden with focusable
// buttons still inside it, which is what axe's `aria-hidden-focus` rule is for,
// and under jsdom that rule cannot answer at all: it comes back `incomplete`,
// which this harness treats as a failure rather than a pass, because a rule that
// cannot produce an answer is not coverage. It is disabled for this one
// assertion with that reason, rather than in `src/test/axe.ts`, because it is
// judgeable everywhere except in a stack.
//
// The timing matters when reading this. A probe that measured after a macrotask
// saw a clean run and no such rule at all: Kobalte aria-hides from its own
// async work, so the state a user meets is the settled one an animation frame
// later, not the one immediately after the event.
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROMPT = "Username for 'https://github.com'";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    bridge.handlers[name] = fn;
    return Promise.resolve(() => {});
  },
}));

const { default: AskpassDialog } = await import("./AskpassDialog");
const { default: ConfirmDialog } = await import("./ConfirmDialog");

/** The panel that contains this text, whether or not it is the top layer. */
const panelWith = (text: string) =>
  screen.getByText(text).closest("[role='dialog']") as HTMLElement;

const askpassInput = () => document.querySelector<HTMLInputElement>(`.${styles.modalInput}`)!;

beforeEach(() => {
  bridge.calls.length = 0;
  for (const key of Object.keys(bridge.handlers)) delete bridge.handlers[key];
});

/** A confirm dialog, then a credential prompt raised on top of it. */
async function stack() {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(() => (
    <>
      <ConfirmDialog
        title="Delete branch"
        message="This cannot be undone."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
      <AskpassDialog />
    </>
  ));
  await waitFor(() => expect(bridge.handlers["askpass://prompt"]).toBeTruthy());
  await frame();

  bridge.handlers["askpass://prompt"]({
    payload: { id: 1, op_id: "op-1", prompt: PROMPT, kind: "username" },
  });
  await frame();

  return { onCancel, onConfirm };
}

describe("two dialogs open at once", () => {
  it("puts the newer one on top without unmounting the older", async () => {
    await stack();

    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(screen.getByText("Delete branch")).toBeTruthy();
    expect(panelWith(PROMPT)).not.toBe(panelWith("Delete branch"));
  });

  it("gives focus to the newer one", async () => {
    await stack();

    expect(document.activeElement).toBe(askpassInput());
  });

  it("gives focus back to the older one when the newer is answered", async () => {
    await stack();

    fireEvent.click(within(panelWith(PROMPT)).getByRole("button", { name: "Cancel" }));
    await macrotask();

    expect(panelWith("Delete branch").contains(document.activeElement)).toBe(true);
  });

  it("leaves the older one working once it is uncovered", async () => {
    const { onCancel } = await stack();

    fireEvent.click(within(panelWith(PROMPT)).getByRole("button", { name: "Cancel" }));
    await macrotask();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not answer the credential prompt for the covered dialog's sake", async () => {
    await stack();

    // The confirm dialog is underneath, still mounted, and its own resolver has
    // not been touched: only the top layer takes input.
    expect(bridge.calls.filter((c) => c.cmd === "askpass_respond")).toEqual([]);
  });

  it("has no accessibility violations while stacked, bar the one jsdom cannot judge", async () => {
    await stack();

    // `aria-hidden-focus` is exactly what a stack produces and exactly what
    // jsdom cannot decide, since it has no way to tell whether the buttons
    // under an aria-hidden layer are really reachable. Every other rule still
    // runs, so a real regression in the stacked state is still caught here.
    await expectNoAxeViolations(document.body, {
      rules: { "aria-hidden-focus": { enabled: false } },
    });
  });
});
