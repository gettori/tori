import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "../../test/harness";

const A = "/root/work/repo-a";

const bridge = vi.hoisted(() => ({
  ended: [] as string[],
  toasts: [] as string[],
  answers: [] as { sessionId: string; done: (ok: boolean) => void }[],
}));

const orphan = (sessionId: string) => ({ type: "orphan", sessionId, childPid: 1, agent: "claude" });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "chat_orphans") return Promise.resolve([orphan("s-1"), orphan("s-2")]);
    if (cmd === "chat_terminate_orphan") {
      const sessionId = args!.sessionId as string;
      return new Promise<void>((yes, no) =>
        bridge.answers.push({
          sessionId,
          done: (ok) => {
            if (ok) bridge.ended.push(sessionId);
            if (ok) yes();
            else no(`could not end ${sessionId}`);
          },
        }),
      );
    }
    if (cmd === "list_sessions" || cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "refresh_agent_health" || cmd === "list_agents") return Promise.resolve([]);
    if (cmd === "session_running") return Promise.resolve(false);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("./TerminalView", () => ({ default: () => <div data-testid="pty" /> }));
vi.mock("../Chat/ChatView", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../Chat/ChatDraft", () => ({ default: () => <div data-testid="draft" /> }));

const { default: Terminal } = await import("./Terminal");
const { default: PaneView } = await import("../../tabs/PaneView");
const { resetTerminalTabModel } = await import("./terminalTabStore");
const { resetPaneLayoutModel, ensureEnvelope, seedOnePane } = await import("../../layout/layoutStore");
const { onWith, TOAST } = await import("../../utils/events");
type ToastEvent = import("../../utils/events").ToastEvent;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const unit = {
  spaceName: "work",
  projectName: "repo-a",
  projectPath: A,
  folderPath: A,
  branch: "main",
  projectKind: "plain",
} as never;

const banner = () => {
  const text = document.body.textContent ?? "";
  return text.includes("survived a crash") ? text : null;
};
const sees = (pattern: RegExp) => waitFor(() => expect(banner() ?? "").toMatch(pattern));
const mount = () =>
  render(() => (
    <>
      <Terminal selected={unit} onOpenChange={() => {}} />
      <PaneView pinKind="shell" />
    </>
  ));
const answer = async (sessionId: string, ok: boolean) => {
  await waitFor(() => expect(bridge.answers.some((a) => a.sessionId === sessionId)).toBe(true));
  const i = bridge.answers.findIndex((a) => a.sessionId === sessionId);
  bridge.answers.splice(i, 1)[0].done(ok);
};

let offToast: (() => void) | undefined;
beforeEach(() => {
  resetTerminalTabModel();
  resetPaneLayoutModel();
  ensureEnvelope(A, seedOnePane);
  bridge.ended.length = 0;
  bridge.toasts.length = 0;
  bridge.answers.length = 0;
  offToast?.();
  offToast = onWith<ToastEvent>(TOAST, (t) => bridge.toasts.push(t.message));
});

describe("ending chat sessions a crash left running", () => {
  it("hides the banner at once and keeps it gone once both end", async () => {
    mount();
    await sees(/2 chat sessions survived a crash/);

    fireEvent.click(screen.getByRole("button", { name: "End them" }));
    await waitFor(() => expect(banner()).toBeNull());

    await answer("s-1", true);
    await answer("s-2", true);
    await waitFor(() => expect(bridge.ended).toEqual(["s-1", "s-2"]));
    expect(banner()).toBeNull();
  });

  it("brings back the one that would not end, and says why", async () => {
    mount();
    await sees(/2 chat sessions survived a crash/);

    fireEvent.click(screen.getByRole("button", { name: "End them" }));
    await waitFor(() => expect(banner()).toBeNull());

    await answer("s-1", true);
    await answer("s-2", false);
    await sees(/1 chat session survived a crash/);
    expect(bridge.toasts).toContain("could not end s-2");
  });
});
