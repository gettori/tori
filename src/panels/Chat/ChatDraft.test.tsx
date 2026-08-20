import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

// Every call this surface could make to the backend, counted. The draft's whole
// promise is that it makes none: no `chat_spawn`, so no child process, no
// claimed session id and nothing registered as live for a chat nobody has sent
// to yet. Asserting it here rather than by counting processes is what makes it a
// property of the code instead of an observation about one run.
const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

import ChatDraft from "./ChatDraft";
import {
  clearComposer,
  draftFor,
  hasAutoSend,
  offerToComposer,
  pendingFor,
  selectionBlocks,
  setDraft,
  takeAutoSend,
} from "../../utils/chatCompose";

// The draft is the state a chat is in before it costs anything: no child, no
// session id, no claim. What these pin is the handover - that the first message
// survives the composer clearing itself, that it is held rather than sent, and
// that a second Enter cannot buy a second session.

const TAB = "chat:draft-1";

afterEach(() => {
  clearComposer(TAB);
  invoke.mockClear();
});

function setup(over: Partial<Parameters<typeof ChatDraft>[0]> = {}) {
  const onStart = vi.fn();
  const result = render(() => (
    <ChatDraft tabId={TAB} cwd="/work/repo" active={true} onStart={onStart} {...over} />
  ));
  const input = result.container.querySelector("textarea") as HTMLTextAreaElement;
  return { ...result, input, onStart };
}

describe("a chat draft costs nothing", () => {
  // The whole point of opening a chat lazily: a tab opened and never used spawns
  // no agent, mints no session id and claims nothing, so it cannot contend with
  // a session running anywhere else either.
  it("makes no backend call at all while it is a draft", () => {
    setup();
    expect(invoke).not.toHaveBeenCalled();
  });

  // Typing is not starting. The message is composed entirely client-side, and
  // only Enter decides there is going to be a session.
  it("still makes none while it is being typed into", () => {
    const { input } = setup();
    fireEvent.input(input, { target: { value: "thinking about it" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  // The draft hands over rather than sending: spawning, claiming and sending all
  // belong to the surface that has a session.
  it("asks its tab to start one rather than starting anything itself", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a chat draft's first send", () => {
  it("holds the message instead of sending it, and asks for a session", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "start here" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Held under the tab, which is what survives the surface being replaced.
    expect(takeAutoSend(TAB)).toBe("start here");
    // Deferred one microtask so the composer finishes its own submit first.
    await Promise.resolve();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // The composer empties itself the moment `onSend` returns. A flag plus the
  // draft text would lose the message to that clear; holding the text is what
  // makes the handover survive it.
  it("keeps the message even though the composer clears itself", async () => {
    const { input } = setup();
    fireEvent.input(input, { target: { value: "do not lose me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(draftFor(TAB)).toBe("");
    expect(takeAutoSend(TAB)).toBe("do not lose me");
  });

  // One session per send, not one per keypress: the surface is on its way out
  // for the whole window between Enter and the swap being drawn.
  it("starts one session however many times Enter is pressed", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // An empty send would cost a process and a session id for nothing.
  it("does not start a session on an empty composer", async () => {
    const { input, onStart } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).not.toHaveBeenCalled();
    expect(hasAutoSend(TAB)).toBe(false);
  });

  // Attachments alone are a real thing to send, and the chips ride to the
  // session the same way the text does.
  it("starts on attachments alone", async () => {
    offerToComposer(TAB, selectionBlocks("/work/repo/a.ts", 1, 4, "x"));
    const { input, onStart } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(takeAutoSend(TAB)).toBe("");
    // Left for the session to take with its first turn, not consumed here.
    expect(pendingFor(TAB)).toHaveLength(1);
  });

  it("shows what a chat is typed into before it exists", () => {
    setDraft(TAB, "already typed");
    const { input } = setup();
    expect(input.value).toBe("already typed");
  });

  // Filed under the tab and cleared only when the tab goes, so every unmount
  // that is not a close - a tab switch, the swap a first send makes, the swap
  // back a failed one makes - leaves the text where the user put it.
  it("still has what was typed after its surface has been torn down", () => {
    const first = setup();
    fireEvent.input(first.input, { target: { value: "half a thought" } });
    first.unmount();

    const again = setup();
    expect(again.input.value).toBe("half a thought");
  });

  // The reason a first send came back, rendered where the decision about what to
  // do next gets made.
  it("says why a first send never reached a session", () => {
    const { container } = setup({ error: "that agent is not installed." });
    expect(container.textContent).toContain("that agent is not installed.");
  });

  it("says nothing at all when there is nothing to report", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("never");
  });
});
