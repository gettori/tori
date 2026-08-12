import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";

// Characterization test for the credential dialog behind the askpass bridge,
// written against the hand-rolled implementation and kept green across the
// migration onto `components/Dialog` (#99). See `ConfirmDialog.test.tsx` for
// why the file splits into a **contract** block that must survive the swap
// unchanged and a **shape** block that is knowingly rewritten with it.
//
// What has to hold is the wire contract with `askpass_respond`, because both
// answers are load-bearing and neither is visible on screen: a value means
// "here is the credential", and `null` means "cancel the whole git op", which
// latches so the sibling field prompt of the same op auto-returns empty instead
// of opening a second dialog. A migration that dropped the null, or that let a
// typed secret survive into the next prompt, would leak or hang rather than
// look wrong.
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Prompt = { id: number; op_id: string; prompt: string; kind: string };

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

const prompt = (over: Partial<Prompt> = {}): Prompt => ({
  id: 1,
  op_id: "op-1",
  prompt: "Username for 'https://github.com'",
  kind: "username",
  ...over,
});

/** Mount the dialog and wait for its `listen` to be in place. The subscription
 *  is awaited inside `onMount`, so an event emitted before it lands on nobody. */
async function mount() {
  render(() => <AskpassDialog />);
  await waitFor(() => expect(bridge.handlers["askpass://prompt"]).toBeTruthy());
  return (p: Prompt) => bridge.handlers["askpass://prompt"]({ payload: p });
}

const input = () => document.querySelector<HTMLInputElement>(`.${styles.input}`);
const respondCalls = () => bridge.calls.filter((c) => c.cmd === "askpass_respond");

beforeEach(() => {
  bridge.calls.length = 0;
  for (const key of Object.keys(bridge.handlers)) delete bridge.handlers[key];
});

describe("AskpassDialog", () => {
  describe("contract", () => {
    it("shows nothing until git asks for something", async () => {
      await mount();

      expect(input()).toBeNull();
    });

    it("opens on an askpass prompt, showing git's own question", async () => {
      const emit = await mount();

      emit(prompt());

      expect(screen.getByText("Username for 'https://github.com'")).toBeTruthy();
      expect(input()).toBeTruthy();
    });

    it("focuses the field so the credential can be typed straight away", async () => {
      const emit = await mount();

      emit(prompt());
      await frame();

      expect(document.activeElement).toBe(input());
    });

    it("relays the typed value on Enter", async () => {
      const emit = await mount();

      emit(prompt());
      fireEvent.input(input()!, { target: { value: "skarif2" } });
      fireEvent.keyDown(input()!, { key: "Enter" });

      expect(respondCalls()).toEqual([
        { cmd: "askpass_respond", args: { id: 1, value: "skarif2" } },
      ]);
    });

    it("relays the typed value when OK is clicked", async () => {
      const emit = await mount();

      emit(prompt());
      fireEvent.input(input()!, { target: { value: "skarif2" } });
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(respondCalls()).toEqual([
        { cmd: "askpass_respond", args: { id: 1, value: "skarif2" } },
      ]);
    });

    it("relays null on Escape, which cancels the whole git op", async () => {
      const emit = await mount();

      emit(prompt());
      fireEvent.input(input()!, { target: { value: "half-typed" } });
      fireEvent.keyDown(input()!, { key: "Escape" });

      expect(respondCalls()).toEqual([{ cmd: "askpass_respond", args: { id: 1, value: null } }]);
    });

    it("relays null when Cancel is clicked", async () => {
      const emit = await mount();

      emit(prompt());
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(respondCalls()).toEqual([{ cmd: "askpass_respond", args: { id: 1, value: null } }]);
    });

    it("closes once the queue is empty", async () => {
      const emit = await mount();

      emit(prompt());
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(input()).toBeNull();
    });

    it("masks a password and says what git actually wants", async () => {
      const emit = await mount();

      emit(prompt({ kind: "password", prompt: "Password for 'https://github.com'" }));

      expect(input()!.type).toBe("password");
      expect(
        screen.getByText(
          "HTTPS wants a personal access token, not your account password.",
        ),
      ).toBeTruthy();
    });

    it("does not offer the token hint for a username", async () => {
      const emit = await mount();

      emit(prompt());

      expect(input()!.type).toBe("text");
      expect(screen.queryByText(/personal access token/)).toBeNull();
    });

    it("shows queued prompts in turn, retaining nothing from the answered one", async () => {
      const emit = await mount();

      // git asks per field as separate processes, so both can be in flight.
      emit(prompt({ id: 1, prompt: "Username for 'https://github.com'" }));
      emit(prompt({ id: 2, kind: "password", prompt: "Password for 'https://github.com'" }));

      fireEvent.input(input()!, { target: { value: "skarif2" } });
      fireEvent.keyDown(input()!, { key: "Enter" });

      expect(screen.getByText("Password for 'https://github.com'")).toBeTruthy();
      expect(input()!.value).toBe("");
      await frame();
      expect(document.activeElement).toBe(input());

      fireEvent.input(input()!, { target: { value: "hunter2" } });
      fireEvent.keyDown(input()!, { key: "Enter" });

      expect(respondCalls()).toEqual([
        { cmd: "askpass_respond", args: { id: 1, value: "skarif2" } },
        { cmd: "askpass_respond", args: { id: 2, value: "hunter2" } },
      ]);
    });
  });

  describe("shape", () => {
    it("cancels on a pointer down outside the panel", async () => {
      const emit = await mount();

      emit(prompt());
      // Kobalte installs its outside-pointerdown listener from a
      // `setTimeout(0)`, so a press fired before this yield lands on nobody.
      await macrotask();
      fireEvent.pointerDown(document.body);

      expect(respondCalls()).toEqual([{ cmd: "askpass_respond", args: { id: 1, value: null } }]);
    });

    it("stays open on a pointer down inside the panel", async () => {
      const emit = await mount();

      emit(prompt());
      await macrotask();
      fireEvent.pointerDown(screen.getByRole("dialog"));

      expect(respondCalls()).toEqual([]);
      expect(input()).toBeTruthy();
    });
  });

  // Scoped to `document.body`: the panel is portalled out of the render
  // container, and modality is expressed by aria-hiding its siblings.
  describe("accessibility", () => {
    it("has no violations while asking for a username", async () => {
      const emit = await mount();

      emit(prompt());

      await expectNoAxeViolations(document.body);
    });

    it("has no violations while asking for a secret", async () => {
      const emit = await mount();

      emit(prompt({ kind: "password", prompt: "Password for 'https://github.com'" }));

      await expectNoAxeViolations(document.body);
    });
  });
});
