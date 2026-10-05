import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import type { Selection } from "../LeftSidebar/LeftSidebar";

// "Ask the agent about this frame", from the pane's side.
//
// `debugAsk.ts` owns the sentence and is tested on its own against fixed
// inputs. This is the part it cannot see: that both buttons exist, that they
// read the *same* live stores, and that what leaves the pane is one line at the
// selected session's prompt.
//
// The whole point of one composer is that two entry points cannot drift into
// two questions, and the only place that claim can be checked is here, with
// both buttons on screen at once over a real paused run.

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/index.ts`;

const SELECTED: Selection = {
  spaceName: "personal",
  projectName: "proj",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "git",
  agent: "claude",
  profile: null,
  sessionId: "s1",
  sessionCwd: REPO,
};

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "dap_start":
      case "dap_connect": {
        const handle: Handle = {
          server: cmd === "dap_connect" ? (args!.server as string) : "dap0",
          session: `sess${sessionCounter++}`,
        };
        channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
        return Promise.resolve(handle);
      }
      case "dap_send": {
        const handle = args!.handle as Handle;
        const frame = JSON.parse(args!.message as string) as Record<string, unknown>;
        if (frame.type === "request") {
          const command = frame.command as string;
          const requestArgs = (frame.arguments ?? {}) as Record<string, unknown>;
          sent.push({ command, args: requestArgs });
          void Promise.resolve().then(() =>
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command,
              success: true,
              body: bodyFor(command, requestArgs),
            }),
          );
        }
        return Promise.resolve();
      }
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));

function bodyFor(command: string, args: Record<string, unknown>): unknown {
  if (command === "initialize") return { supportsConfigurationDoneRequest: true, supportsSetVariable: true };
  if (command === "stackTrace")
    return {
      stackFrames: [
        { id: 1, name: "total", source: { path: FILE, name: "index.ts" }, line: 6 },
        { id: 2, name: "run", source: { path: `${REPO}/src/main.ts`, name: "main.ts" }, line: 12 },
      ],
    };
  if (command === "scopes")
    return { scopes: [{ name: "Locals", variablesReference: 100, expensive: false }] };
  if (command === "variables") {
    if (args.variablesReference !== 100) return { variables: [] };
    return {
      variables: [
        // A value with a newline in it, which is what a thrown Error looks like
        // to `evaluate`: the console keeps those and the prompt cannot.
        { name: "err", value: "Error: boom\n    at total (index.ts:6)", variablesReference: 0 },
        { name: "count", value: "3", type: "number", variablesReference: 0 },
      ],
    };
  }
  return {};
}

const { default: DebugPanel } = await import("./DebugPanel");
const dap = await import("../../utils/dapSessions");
const { sanitizeForSend } = await import("../../utils/safeSend");
const { onWith, emitWith, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, TOAST } = await import(
  "../../utils/events"
);

type SendRequest = { requestId: string; text: string; sessionId: string };

/** Stand in for Terminal.tsx: take the request off the bus and answer it, so
 *  `requestSend` resolves instead of sitting out its own timeout. */
function collectSends(): { sends: SendRequest[]; off: () => void } {
  const sends: SendRequest[] = [];
  const off = onWith<SendRequest>(SEND_TO_SESSION, (req) => {
    sends.push(req);
    emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
  });
  return { sends, off };
}

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

const start = {
  adapterId: "js-debug",
  childSessions: true,
  filePath: FILE,
  projectPath: REPO,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A run paused at a breakpoint with the pane on screen and a session selected. */
async function pausedPane(selected: Selection | null = SELECTED) {
  const root = await dap.startDebugSession(start);
  await flush();
  render(() => <DebugPanel root={REPO} selected={selected} />);
  event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
  await waitFor(() => expect(screen.queryByText("Locals")).toBeTruthy());
}

// By label rather than by title: the title is the capability gate's reason, so
// it changes when there is no session to send to and the button is still there.
const askButtons = () => screen.getAllByText("Ask");

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  await flush();
  cleanup();
  warn.mockRestore();
});

describe("asking the agent about the paused frame", () => {
  it("offers it from the stack pane and from the variables tree, and both ask the same thing", async () => {
    await pausedPane();
    const { sends, off } = collectSends();

    // Exactly two: the selected frame's row, and the variables heading. An
    // unselected frame carries none, because it is not the frame the message
    // would describe.
    expect(askButtons()).toHaveLength(2);
    // Both say the same thing, which used to be a `title` and is now the
    // tooltip: focus is what opens it, and focus is exactly what a `title`
    // never answered to. Blurred between the two so only one is ever open.
    for (const button of askButtons()) {
      const control = button.closest("button")!;
      expect(control.getAttribute("title")).toBeNull();
      fireEvent.focus(control);
      await waitFor(() =>
        expect(screen.getByRole("tooltip").textContent).toBe("Ask the agent about this frame"),
      );
      fireEvent.blur(control);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    }

    fireEvent.click(askButtons()[0]);
    await waitFor(() => expect(sends).toHaveLength(1));
    fireEvent.click(askButtons()[1]);
    await waitFor(() => expect(sends).toHaveLength(2));
    off();

    expect(sends[1].text).toBe(sends[0].text);
    expect(sends[0].sessionId).toBe("s1");
  });

  it("carries where it stopped, how it got there, and stays on one line", async () => {
    await pausedPane();
    // Opened, so the scope actually has rows: an unexpanded tree has fetched
    // nothing, which is a different message.
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    const { sends, off } = collectSends();
    fireEvent.click(askButtons()[0]);
    await waitFor(() => expect(sends).toHaveLength(1));
    off();

    const text = sends[0].text;
    // Relative to the session's cwd, the drag-mention convention every other
    // composed message follows.
    expect(text).toContain("@src/index.ts#L6");
    expect(text).toContain("Stack: total (index.ts:6) < run (main.ts:12).");
    expect(text).toContain("Locals: err = Error: boom at total (index.ts:6), count = 3.");
    // Insert-only: a raw newline in a PTY write is a carriage return at an
    // agent's prompt, which would submit half the message.
    expect(text).not.toMatch(/\n/);
    expect(sanitizeForSend(text)).toBe(text);
  });

  it("says the tree is closed rather than implying the frame had no variables", async () => {
    await pausedPane();
    const { sends, off } = collectSends();

    fireEvent.click(askButtons()[1]);
    await waitFor(() => expect(sends).toHaveLength(1));
    off();

    expect(sends[0].text).toContain("No scope is expanded");
  });

  it("refuses with a reason when there is no session to send to", async () => {
    await pausedPane(null);
    const toasts: { message: string }[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
    const { sends, off } = collectSends();

    fireEvent.click(askButtons()[0]);
    await flush();
    off();
    offToast();

    expect(sends).toEqual([]);
    expect(toasts[0].message).toBe("Select a session first");
  });
});
