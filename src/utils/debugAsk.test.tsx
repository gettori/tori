import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { SessionTarget } from "./safeSend";
import type { StackFrame } from "./debugStack";
import type { VarRow, VarScope } from "./debugVariables";

// "Ask the agent about this frame": the message, and the one path that sends
// it. The message is the part that can be quietly wrong - it is pasted into a
// prompt, so a stray newline would submit half of it, and it is assembled from
// the debuggee's own strings, which can be a megabyte of serialized object.
//
// A `.tsx` with no JSX in it (`conflictAsk.test.tsx`'s reason): the send half
// rides the window event bus, so it needs a document, and the extension is what
// picks the environment.
//
// The two debug stores are mocked rather than driven through a fake adapter.
// What is under test here is the sentence, not the fetching; the fetching has
// its own tests, and the pane test drives the real thing end to end.

const REPO = "/space/proj/main";
const TARGET: SessionTarget = {
  sessionId: "s1",
  agent: "claude",
  profile: null,
  folderPath: REPO,
  sessionCwd: REPO,
};

let paused: { stop: { id: string; name: string; reason: string; frames: StackFrame[] }; frame: StackFrame } | null =
  null;
let scopes: VarScope[] = [];
let rowsByKey = new Map<string, VarRow[]>();
let moreByKey = new Map<string, number>();

vi.mock("./debugStack", () => ({
  currentFrame: () => paused,
}));

vi.mock("./debugVariables", () => ({
  debugScopes: () => scopes,
  variableRows: (key: string) => rowsByKey.get(key) ?? [],
  variableMore: (key: string) => moreByKey.get(key) ?? 0,
}));

const { composeFrame, frameAsk, askAgentAboutFrame, TEXT_CAP } = await import("./debugAsk");
const { sanitizeForSend } = await import("./safeSend");
const { onWith, emitWith, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, TOAST } = await import("./events");

type Sent = { requestId: string; text: string; sessionId: string };

/** Stand in for Terminal.tsx: take the request off the bus and answer it, so
 *  `requestSend` resolves instead of sitting out its own timeout. */
function collectSends(result: "sent" | "blocked" | "timeout" = "sent"): { sent: Sent[]; off: () => void } {
  const sent: Sent[] = [];
  const off = onWith<Sent>(SEND_TO_SESSION, (req) => {
    sent.push(req);
    emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result });
  });
  return { sent, off };
}

function frame(name: string, file: string | null, line: number, sourceName: string): StackFrame {
  return {
    id: line,
    name,
    path: file,
    sourceName,
    sourceReference: file ? 0 : 42,
    line,
    column: 1,
  };
}

function row(name: string, value: string): VarRow {
  return {
    key: `k:${name}`,
    name,
    value,
    type: null,
    variablesReference: 0,
    indexedVariables: 0,
    parentReference: 100,
  };
}

const TOP = frame("total", `${REPO}/src/index.ts`, 6, "index.ts");
const CALLER = frame("run", `${REPO}/src/main.ts`, 12, "main.ts");
const STOP = { name: "index.ts", reason: "breakpoint" };
const LOCALS = { name: "Locals", rows: [row("count", "3"), row("user", "Object")] };

beforeEach(() => {
  paused = null;
  scopes = [];
  rowsByKey = new Map<string, VarRow[]>();
  moreByKey = new Map<string, number>();
});

describe("composing the frame", () => {
  it("pins the whole sentence: which session, why, where, how it got there, what is in scope", () => {
    // Byte for byte, because every clause is load-bearing and the two entry
    // points are only "the same question" if this string is fixed.
    expect(composeFrame(TARGET, STOP, TOP, [TOP, CALLER], [LOCALS])).toBe(
      "index.ts is paused on breakpoint in total at @src/index.ts#L6. " +
        "Stack: total (index.ts:6) < run (main.ts:12). " +
        "Locals: count = 3, user = Object.",
    );
  });

  it("keeps a path outside the session's cwd absolute", () => {
    // The drag-mention convention every other composed message follows: inside
    // the cwd relative, outside it absolute, because a relative path the agent
    // cannot resolve points at nothing.
    const outside = frame("boot", "/other/repo/src/boot.ts", 3, "boot.ts");
    expect(composeFrame(TARGET, STOP, outside, [outside], [LOCALS])).toContain(
      "at @/other/repo/src/boot.ts#L3.",
    );
  });

  it("names a frame with no file rather than mentioning one", () => {
    // A bundled dependency or an eval has no path any tool could read, so an
    // `@` on it would be a promise nothing can keep.
    const virtual = frame("require", null, 9, "<eval>/VM123");
    const text = composeFrame(TARGET, STOP, virtual, [virtual], [LOCALS]);
    expect(text).toContain("at <eval>/VM123:9.");
    expect(text).not.toContain("@<eval>");
  });

  it("leaves out the stack when there is only the one frame", () => {
    // It would say the same thing twice in two shapes.
    expect(composeFrame(TARGET, STOP, TOP, [TOP], [LOCALS])).toBe(
      "index.ts is paused on breakpoint in total at @src/index.ts#L6. Locals: count = 3, user = Object.",
    );
  });

  it("says when nothing is expanded, rather than reading as a frame with no variables", () => {
    expect(composeFrame(TARGET, STOP, TOP, [TOP], [{ name: "Locals", rows: [] }])).toContain(
      "No scope is expanded, so no variables are included.",
    );
  });

  it("bounds a five-thousand-name scope and states what it left out", () => {
    // The case this whole module's caps exist for: js-debug will hand over a
    // scope this size, and pasting it costs the user the context window they
    // were about to ask a question in.
    const huge = { name: "Locals", rows: Array.from({ length: 5000 }, (_, i) => row(`v${i}`, String(i))) };
    const text = composeFrame(TARGET, STOP, TOP, [TOP], [huge]);

    expect(text).toContain("Locals: v0 = 0, ");
    expect(text).toContain("v19 = 19, and 4980 more.");
    expect(text).not.toContain("v20 = 20");
    // Bounded, not merely shorter: a cap that still scales with the input is
    // not a cap.
    expect(text.length).toBeLessThan(1000);
  });

  it("clips a frame name too, because js-debug puts source text in one", () => {
    // Measured this phase: js-debug named a frame
    // `function Module(id = '', parent) {.executeUserEntryPoint`, so a frame
    // name is arbitrary program text and a cap that covers only values is not
    // a cap.
    const loud = frame("x".repeat(300), `${REPO}/src/a.ts`, 1, "a.ts");
    const text = composeFrame(TARGET, STOP, TOP, [TOP, loud], []);

    expect(text).toContain(`${"x".repeat(TEXT_CAP)}… (a.ts:1)`);
    expect(text).not.toContain("x".repeat(TEXT_CAP + 1));
  });

  it("counts what the tree never fetched, not just what it cut", () => {
    // A paged container holds one page of a thousand elements. Counting only
    // the rows in hand would report 80 missing out of 980.
    const paged = {
      name: "Locals",
      rows: Array.from({ length: 100 }, (_, i) => row(`v${i}`, String(i))),
      more: 900,
    };
    expect(composeFrame(TARGET, STOP, TOP, [TOP], [paged])).toContain("v19 = 19, and 980 more.");
  });

  it("bounds a deep stack the same way", () => {
    const deep = Array.from({ length: 20 }, (_, i) => frame(`f${i}`, `${REPO}/src/f${i}.ts`, i + 1, `f${i}.ts`));
    const text = composeFrame(TARGET, STOP, deep[0], deep, []);

    expect(text).toContain("Stack: f0 (f0.ts:1) < ");
    expect(text).toContain("f7 (f7.ts:8) < 12 more frames.");
    expect(text).not.toContain("f8 (f8.ts:9)");
  });

  it("bounds the scopes too, and counts the ones it dropped", () => {
    const four = ["Locals", "Closure", "Block", "Global"].map((name) => ({
      name,
      rows: [row("a", "1")],
    }));
    const text = composeFrame(TARGET, STOP, TOP, [TOP], four);

    expect(text).toContain("Block: a = 1.");
    expect(text).not.toContain("Global:");
    expect(text).toContain("And 1 more scope not included.");
  });

  it("clips one enormous value instead of pasting it", () => {
    const long = { name: "Locals", rows: [row("blob", "x".repeat(500))] };
    const text = composeFrame(TARGET, STOP, TOP, [TOP], [long]);

    expect(text).toContain(`blob = ${"x".repeat(TEXT_CAP)}…`);
    expect(text).not.toContain("x".repeat(TEXT_CAP + 1));
  });

  it("stays on one line, so the prompt cannot submit half of it", () => {
    // The safe-send contract. A debuggee's `toString` returns whatever it likes,
    // and `sanitizeOutput` deliberately keeps newlines for the console, so this
    // is the first place they have to go.
    const multi = { name: "Locals", rows: [row("err", "Error: boom\n    at total (index.ts:6)")] };
    const text = composeFrame(TARGET, { name: "a\nb", reason: "exception" }, TOP, [TOP, CALLER], [multi]);

    expect(text).not.toMatch(/\n/);
    expect(sanitizeForSend(text)).toBe(text);
    expect(text).toContain("err = Error: boom at total (index.ts:6)");
  });
});

describe("asking about whatever is selected", () => {
  it("answers nothing when nothing is paused", () => {
    expect(frameAsk(TARGET)).toBeNull();
  });

  it("reads the selected frame and the loaded scopes out of the stores", () => {
    paused = { stop: { id: "sess0", ...STOP, frames: [TOP, CALLER] }, frame: TOP };
    scopes = [
      { key: "sc:1", name: "Locals", variablesReference: 100, expensive: false, indexedVariables: 0 },
      // Never read, because nothing expanded it: an unopened scope has no rows,
      // which is exactly the state the "no scope is expanded" line describes.
      { key: "sc:2", name: "Global", variablesReference: 200, expensive: true, indexedVariables: 0 },
    ];
    rowsByKey.set("sc:1", [row("count", "3"), row("user", "Object")]);
    // The tree's own unfetched count, which `rows` cannot show.
    moreByKey.set("sc:1", 900);

    expect(frameAsk(TARGET)).toBe(
      composeFrame(TARGET, STOP, TOP, [TOP, CALLER], [{ ...LOCALS, more: 900 }]),
    );
    expect(frameAsk(TARGET)).toContain("and 900 more.");
  });

  it("sends it through safe-send, insert-only, at the named session", async () => {
    paused = { stop: { id: "sess0", ...STOP, frames: [TOP] }, frame: TOP };
    const { sent, off } = collectSends();

    await askAgentAboutFrame(TARGET);
    off();

    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe("s1");
    expect(sent[0].text).toBe(frameAsk(TARGET));
    // Nothing here submits: `requestSend` carries text, and Terminal.tsx pastes
    // it without an Enter.
    expect(sent[0]).not.toHaveProperty("submit");
  });

  it("says so when nothing is paused rather than sending an empty question", async () => {
    const toasts: { message: string }[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
    const { sent, off } = collectSends();

    await askAgentAboutFrame(TARGET);
    off();
    offToast();

    expect(sent).toEqual([]);
    expect(toasts[0].message).toContain("Nothing is paused");
  });

  it("reports a Terminal that never answered", async () => {
    paused = { stop: { id: "sess0", ...STOP, frames: [TOP] }, frame: TOP };
    const toasts: { message: string }[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
    const { off } = collectSends("timeout");

    await askAgentAboutFrame(TARGET);
    off();
    offToast();

    expect(toasts[0].message).toContain("Couldn't reach the session");
  });

  it("stays quiet on a blocked target, which Terminal.tsx already toasts", async () => {
    // Two toasts for one refusal would read as two different refusals.
    paused = { stop: { id: "sess0", ...STOP, frames: [TOP] }, frame: TOP };
    const toasts: { message: string }[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
    const { off } = collectSends("blocked");

    await askAgentAboutFrame(TARGET);
    off();
    offToast();

    expect(toasts).toEqual([]);
  });
});
