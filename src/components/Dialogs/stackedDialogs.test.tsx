import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
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
// which this agent treats as a failure rather than a pass, because a rule that
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
const { default: WorktreeRemoveDialog } = await import("./WorktreeRemoveDialog");

/** The panel that contains this text, whether or not it is the top layer. */
const panelWith = (text: string) =>
  screen.getByText(text).closest("[role='dialog']") as HTMLElement;

const askpassInput = () => document.querySelector<HTMLInputElement>(`.${styles.input}`)!;

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

// The stack the #100 migration makes reachable, and the one most likely to
// actually happen: `WorktreeRemoveDialog` stays mounted with `busy` set while
// its removal runs (LeftSidebar sets it before awaiting), and "delete the remote
// branch too" is a `git push --delete`, a network op that raises
// `askpass://prompt` exactly when the covered dialog is mid-flight and holding a
// pending backend call.
//
// That is what separates this from the `ConfirmDialog` stack above: the covered
// layer here is not merely waiting for a person, it is waiting for a process,
// and answering the wrong one would confirm a destructive removal twice.
async function stackOverRemoval(busy = true) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(() => (
    <>
      <WorktreeRemoveDialog
        label="feature/omnibox"
        path="/tmp/feature-omnibox"
        branch="feature/omnibox"
        dirty={false}
        unpushed={false}
        hasRemote={true}
        runningCount={0}
        busy={busy}
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

describe("a credential prompt over a removal that is already running", () => {
  it("raises the prompt without unmounting the removal", async () => {
    await stackOverRemoval();

    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(screen.getByText("Remove worktree “feature/omnibox”?")).toBeTruthy();
    expect(panelWith(PROMPT)).not.toBe(panelWith("Remove worktree “feature/omnibox”?"));
  });

  it("gives focus to the prompt, not to the removal it interrupted", async () => {
    await stackOverRemoval();

    expect(document.activeElement).toBe(askpassInput());
  });

  // Deliberately stacked over a removal that has NOT been confirmed yet, which
  // a background fetch can do at any moment. Over a `busy` removal this
  // assertion would be worthless: the dialog's own busy gate would refuse the
  // confirm even if the key did leak through, so the test would pass against an
  // implementation with no layering at all. Here the layering is the only thing
  // standing between Enter and a destructive removal.
  it("does not confirm the removal underneath when the prompt is answered", async () => {
    const { onConfirm } = await stackOverRemoval(false);

    fireEvent.keyDown(askpassInput(), { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();

    // And the handler underneath is genuinely live, so the non-call above is the
    // layering doing its job rather than a dialog that answers Enter nowhere.
    fireEvent.keyDown(panelWith("Remove worktree “feature/omnibox”?"), { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("gives focus back to the removal when the prompt is answered", async () => {
    await stackOverRemoval();

    fireEvent.click(within(panelWith(PROMPT)).getByRole("button", { name: "Cancel" }));
    await macrotask();

    expect(panelWith("Remove worktree “feature/omnibox”?").contains(document.activeElement)).toBe(true);
  });

  it("leaves the removal dismissable once it is uncovered", async () => {
    const { onCancel } = await stackOverRemoval();

    fireEvent.click(within(panelWith(PROMPT)).getByRole("button", { name: "Cancel" }));
    await macrotask();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("has no accessibility violations while stacked, bar the one jsdom cannot judge", async () => {
    await stackOverRemoval();

    // Same measured exception as the stack above, and for the same reason.
    await expectNoAxeViolations(document.body, {
      rules: { "aria-hidden-focus": { enabled: false } },
    });
  });
});
