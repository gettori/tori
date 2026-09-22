import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";

// Hover-to-inspect: the one debugger surface that lives in the buffer.
//
// Two halves, tested separately because they fail differently. What counts as
// an expression is pure text work and is where an off-by-one or a swallowed
// receiver hides; whether anything is asked at all is a question about the
// program's state, and asking a running program is the failure that matters.

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/index.ts`;

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
let evaluateAnswer: unknown = { result: "{ id: 'u1' }", type: "Object" };
const failCommands = new Set<string>();

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
          sent.push({ command, args: (frame.arguments ?? {}) as Record<string, unknown> });
          const failed = failCommands.has(command);
          void Promise.resolve().then(() =>
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command,
              success: !failed,
              ...(failed ? { message: "not available" } : {}),
              body: bodyFor(command),
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

vi.mock("../../utils/events", async () => {
  const actual = await vi.importActual<typeof import("../../utils/events")>("../../utils/events");
  return { ...actual, emitWith: () => {} };
});

function bodyFor(command: string): unknown {
  if (command === "initialize") return { supportsConfigurationDoneRequest: true };
  if (command === "stackTrace")
    return {
      stackFrames: [{ id: 5, name: "total", source: { path: FILE, name: "index.ts" }, line: 6 }],
    };
  if (command === "scopes") return { scopes: [] };
  if (command === "evaluate") return evaluateAnswer;
  return {};
}

const { debugExpressionAt, debugTooltipAt, debugHoverFile } = await import("./debugHover");
const dap = await import("../../utils/dapSessions");

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const start = {
  adapterId: "js-debug",
  childSessions: true,
  filePath: FILE,
  projectPath: REPO,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

/** A buffer holding `path`, which is how the hover knows which file it is in. */
const stateOf = (doc: string, path = FILE) =>
  EditorState.create({ doc, extensions: [debugHoverFile.of(path)] });
/** The offset of the first character of `word` in `doc`, plus one, so the
 *  position is inside the word rather than on its edge. */
const inside = (doc: string, word: string) => doc.indexOf(word) + 1;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  evaluateAnswer = { result: "{ id: 'u1' }", type: "Object" };
  failCommands.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  await flush();
  warn.mockRestore();
});

describe("what counts as an expression", () => {
  it("takes the whole property path, not the word under the pointer", () => {
    const doc = "  return user.address.city;\n";
    // `city` alone means whatever `city` means at the top of the frame, which
    // is usually nothing.
    expect(debugExpressionAt(stateOf(doc), inside(doc, "city"))?.text).toBe("user.address.city");
    expect(debugExpressionAt(stateOf(doc), inside(doc, "address"))?.text).toBe("user.address");
    expect(debugExpressionAt(stateOf(doc), inside(doc, "user"))?.text).toBe("user");
  });

  it("names the range it read, so the tooltip points at the right characters", () => {
    const doc = "const total = count;\n";
    const found = debugExpressionAt(stateOf(doc), inside(doc, "count"));
    expect(doc.slice(found!.from, found!.to)).toBe("count");
  });

  it("keeps `$` and `_` names whole", () => {
    const doc = "  const x = _cache$1.value;\n";
    expect(debugExpressionAt(stateOf(doc), inside(doc, "_cache$1"))?.text).toBe("_cache$1");
  });

  it("stops at a call, because evaluating one would run it", () => {
    const doc = "  const n = load().size;\n";
    // A hover that calls a function is a hover that can change the program.
    expect(debugExpressionAt(stateOf(doc), inside(doc, "size"))?.text).toBe("size");
  });

  it("does not read a decimal literal as a property access", () => {
    const doc = "  const ratio = 3.14;\n";
    expect(debugExpressionAt(stateOf(doc), doc.indexOf("14"))?.text).toBeUndefined();
  });

  it("has nothing to say about whitespace", () => {
    const doc = "  const a = b;\n";
    expect(debugExpressionAt(stateOf(doc), 1)).toBeNull();
    // Past the semicolon there is nothing on either side of the position.
    expect(debugExpressionAt(stateOf(doc), doc.indexOf(";") + 1)).toBeNull();
  });

  it("still names a word the pointer sits at the end of", () => {
    const doc = "  const a = b;\n";
    // A position is a boundary, not a character: the right-hand half of `b` and
    // the gap before the semicolon are the same offset, so refusing it would
    // make half of every identifier unhoverable.
    expect(debugExpressionAt(stateOf(doc), doc.indexOf(";"))?.text).toBe("b");
  });

  it("works on the last line with no trailing newline", () => {
    const doc = "let tail = 1";
    expect(debugExpressionAt(stateOf(doc), inside(doc, "tail"))?.text).toBe("tail");
  });
});

describe("when it asks the adapter", () => {
  async function paused() {
    const root = await dap.startDebugSession(start);
    await flush();
    event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
    await flush();
    return root!.handle.session;
  }

  it("shows the value in the selected frame", async () => {
    await paused();
    const doc = "  return user.address;\n";

    const tip = await debugTooltipAt(stateOf(doc), inside(doc, "address"));

    expect(tip).toBeTruthy();
    expect(sent.filter((s) => s.command === "evaluate")[0].args).toMatchObject({
      expression: "user.address",
      frameId: 5,
      context: "hover",
    });
    const dom = tip!.create({} as never).dom;
    expect(dom.textContent).toContain("{ id: 'u1' }");
    expect(dom.textContent).toContain("Object");
  });

  it("renders the debuggee's own string as characters, not as markup", async () => {
    evaluateAnswer = { result: "<img src=x onerror=boom>", type: null };
    await paused();
    const doc = "  return payload;\n";

    const tip = await debugTooltipAt(stateOf(doc), inside(doc, "payload"));

    // The value is written by whatever is being debugged.
    const dom = tip!.create({} as never).dom;
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.textContent).toBe("<img src=x onerror=boom>");
  });

  it("asks nothing at all while the program is running", async () => {
    const root = await dap.startDebugSession(start);
    await flush();
    const doc = "  return user;\n";

    expect(await debugTooltipAt(stateOf(doc), inside(doc, "user"))).toBeNull();

    // Not merely "shows nothing": a request per pointer movement against a
    // running program is refused by some adapters and answers a stale frame in
    // others, and neither belongs under somebody's pointer.
    expect(sent.filter((s) => s.command === "evaluate")).toEqual([]);
    expect(root).toBeTruthy();
  });

  it("shows nothing for a name the adapter does not know", async () => {
    failCommands.add("evaluate");
    await paused();
    const doc = "  return mystery;\n";

    expect(await debugTooltipAt(stateOf(doc), inside(doc, "mystery"))).toBeNull();
  });

  it("says nothing in a file the pause is not in", async () => {
    await paused();
    const doc = "  return count;\n";

    const tip = await debugTooltipAt(stateOf(doc, `${REPO}/src/other.ts`), inside(doc, "count"));

    // A stopped program makes every open buffer hoverable otherwise, and the
    // answer would be real: it would just be a different `count` than the one
    // being pointed at, with nothing on screen saying so.
    expect(tip).toBeNull();
    expect(sent.filter((s) => s.command === "evaluate")).toEqual([]);
  });
});
