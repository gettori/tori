import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createDapConnection,
  initializeArguments,
  CAPABILITY_OBLIGATIONS,
  REVERSE_REQUESTS,
  type ReverseRequest,
} from "./dapClient";
// Read as text rather than as JSON: the manifest lives outside `src`, and
// `?raw` is how the other source-inspecting tests reach a file (commands,
// revertGuard).
import manifestSource from "../../src-tauri/resources/dap/manifest.json?raw";

/** A connection plus the frames it wrote, which is the whole observable
 *  surface: everything else is fed in through `receive`. */
function agent() {
  const sent: Record<string, unknown>[] = [];
  const conn = createDapConnection((message) => sent.push(JSON.parse(message)));
  return { conn, sent };
}

/** A response frame from the adapter. `seq` is the *adapter's* counter and is
 *  deliberately unrelated to `request_seq` here, because that is the confusion
 *  the correlation rule exists to survive. */
function response(fields: Record<string, unknown>) {
  return JSON.stringify({ seq: 900, type: "response", success: true, ...fields });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Refusals log on purpose; the assertions are about the wire, not the console.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("request correlation", () => {
  it("resolves a request by its request_seq, not by the response's own seq", async () => {
    const { conn, sent } = agent();
    const first = conn.request("stackTrace");
    const second = conn.request("scopes");

    expect(sent.map((f) => f.command)).toEqual(["stackTrace", "scopes"]);
    const [a, b] = sent.map((f) => f.seq as number);

    // Answered out of order, and each response carries an adapter seq that
    // matches the *other* request. Correlating on `seq` would swap them.
    conn.receive(response({ seq: a, request_seq: b, command: "scopes", body: { scopes: [] } }));
    conn.receive(response({ seq: b, request_seq: a, command: "stackTrace", body: { stackFrames: [] } }));

    await expect(first).resolves.toEqual({ stackFrames: [] });
    await expect(second).resolves.toEqual({ scopes: [] });
  });

  it("rejects on success:false, carrying the adapter's own message", async () => {
    const { conn, sent } = agent();
    const pending = conn.request("evaluate");
    conn.receive(
      response({
        request_seq: sent[0].seq,
        command: "evaluate",
        success: false,
        message: "Cannot evaluate code without a selected frame",
      }),
    );
    await expect(pending).rejects.toThrow("Cannot evaluate code without a selected frame");
  });

  it("reads the error body first, which is where js-debug puts the text", async () => {
    const { conn, sent } = agent();
    const pending = conn.request("evaluate");
    // Measured against js-debug 1.117, verbatim: no `message` at all, and the
    // only readable text in `body.error.format`. Reading `message` first turned
    // every failure in the app into the word "failed".
    conn.receive(
      response({
        request_seq: sent[0].seq,
        command: "evaluate",
        success: false,
        body: {
          error: {
            id: 9222,
            format: "Uncaught ReferenceError: notAName is not defined",
            showUser: false,
          },
        },
      }),
    );
    await expect(pending).rejects.toThrow("Uncaught ReferenceError: notAName is not defined");
  });

  it("fills the placeholders the spec puts in that text", async () => {
    const { conn, sent } = agent();
    const pending = conn.request("source");
    conn.receive(
      response({
        request_seq: sent[0].seq,
        command: "source",
        success: false,
        body: { error: { format: "No source for {ref} in {name}", variables: { ref: "42" } } },
      }),
    );
    // A leaked `{name}` in a message under someone's cursor is worse than no
    // message, so an unfilled placeholder is left as written rather than blanked.
    await expect(pending).rejects.toThrow("No source for 42 in {name}");
  });

  it("ignores a response nothing is waiting for", () => {
    const { conn } = agent();
    expect(() => conn.receive(response({ request_seq: 4242, command: "ghost" }))).not.toThrow();
  });

  it("rejects everything in flight when the session goes away", async () => {
    const { conn } = agent();
    const pending = conn.request("variables");
    conn.dispose("the debug session ended");
    await expect(pending).rejects.toThrow("the debug session ended");
    // And nothing arriving afterwards is dispatched: a late frame from a socket
    // that has not drained must not resurrect a dead session.
    expect(() => conn.receive(response({ request_seq: 1, command: "variables" }))).not.toThrow();
  });
});

describe("event fan-out", () => {
  it("delivers one event to every subscriber", () => {
    const { conn } = agent();
    const seen: string[] = [];
    conn.on("stopped", (body) => seen.push(`a:${(body as { reason: string }).reason}`));
    conn.on("stopped", (body) => seen.push(`b:${(body as { reason: string }).reason}`));

    conn.receive(JSON.stringify({ seq: 1, type: "event", event: "stopped", body: { reason: "breakpoint" } }));

    expect(seen).toEqual(["a:breakpoint", "b:breakpoint"]);
  });

  it("lets a subscriber unsubscribe from inside its own call", () => {
    const { conn } = agent();
    let calls = 0;
    const off = conn.on("initialized", () => {
      calls += 1;
      off();
    });
    const frame = JSON.stringify({ seq: 1, type: "event", event: "initialized" });
    conn.receive(frame);
    conn.receive(frame);
    expect(calls).toBe(1);
  });

  it("does not let one failing subscriber starve the next", () => {
    const { conn } = agent();
    let reached = false;
    conn.on("output", () => {
      throw new Error("boom");
    });
    conn.on("output", () => {
      reached = true;
    });
    conn.receive(JSON.stringify({ seq: 1, type: "event", event: "output", body: {} }));
    expect(reached).toBe(true);
  });
});

describe("the reverse-request router", () => {
  it("answers every reverse request the adapter can send", () => {
    const { conn, sent } = agent();

    for (const [index, command] of REVERSE_REQUESTS.entries()) {
      conn.receive(JSON.stringify({ seq: 100 + index, type: "request", command, arguments: {} }));
    }

    // None left unanswered: an adapter waiting on a reply Tori never sends is
    // the failure this router exists for, and it is completely silent.
    expect(sent).toHaveLength(REVERSE_REQUESTS.length);
    for (const [index, command] of REVERSE_REQUESTS.entries()) {
      const reply = sent[index];
      expect(reply.type).toBe("response");
      expect(reply.command).toBe(command);
      expect(reply.request_seq).toBe(100 + index);
      // A refusal, not a "no such method": the adapter is told what Tori will
      // not do and why, in a body it can render.
      expect(reply.success).toBe(false);
      expect(String(reply.message)).not.toMatch(/not implement|method not found/i);
      expect((reply.body as { error: { format: string } }).error.format).toBe(reply.message);
    }
  });

  it("answers a served request with its handler's body", async () => {
    const { conn, sent } = agent();
    conn.onReverse("startDebugging", () => ({}));
    expect(conn.refuses("startDebugging")).toBe(false);

    conn.receive(JSON.stringify({ seq: 7, type: "request", command: "startDebugging", arguments: {} }));

    expect(sent[0]).toMatchObject({ type: "response", request_seq: 7, success: true, body: {} });
  });

  it("answers a handler that throws with a failure rather than nothing", () => {
    const { conn, sent } = agent();
    conn.onReverse("remoteFileExists", () => {
      throw new Error("no");
    });
    conn.receive(JSON.stringify({ seq: 8, type: "request", command: "remoteFileExists" }));
    expect(sent[0]).toMatchObject({ request_seq: 8, success: false, message: "no" });
  });

  it("answers a name it has never heard of instead of leaving it hanging", () => {
    const { conn, sent } = agent();
    conn.receive(JSON.stringify({ seq: 9, type: "request", command: "somethingBrandNew" }));
    expect(sent[0]).toMatchObject({ request_seq: 9, success: false });
  });

  it("leaves a notification-shaped frame alone", () => {
    const { conn, sent } = agent();
    // No `seq` of its own to answer against, and no id: replying would put a
    // response on the wire that correlates with nothing.
    conn.receive(JSON.stringify({ type: "event", event: "runInTerminal" }));
    expect(sent).toEqual([]);
  });
});

describe("the reverse-request list", () => {
  it("matches the installer's manifest exactly", () => {
    const manifest = JSON.parse(manifestSource) as { expect: { reverseRequests: string[] } };
    // `scripts/install-dap.mjs` rediscovers these structurally from the bundle
    // on every install, so a bumped adapter that added a sixth fails here until
    // it has a handler. Phase 2 found `remoteFileExists` this way, which
    // neither the plan nor two adversary passes had.
    expect([...REVERSE_REQUESTS].sort()).toEqual([...manifest.expect.reverseRequests].sort());
  });

  it("gives every name a router entry from birth", () => {
    const { conn } = agent();
    expect(conn.handledReverseRequests()).toEqual([...REVERSE_REQUESTS].sort());
  });
});

describe("the initialize payload", () => {
  const args = initializeArguments("js-debug", true);

  it("pins the Phase 1 line and column base", () => {
    // Flipping either silently moves every breakpoint, stack frame and
    // current-line highlight by one, with no error anywhere.
    expect(args.linesStartAt1).toBe(true);
    expect(args.columnsStartAt1).toBe(true);
    expect(args.pathFormat).toBe("path");
  });

  it("names the adapter it is handshaking with", () => {
    expect(args.adapterID).toBe("js-debug");
  });

  it("declares a request-implying capability only when Tori actually serves it", () => {
    const { conn } = agent();
    // A fresh connection refuses everything; the real handlers are installed by
    // `dapSessions.ts`, so this asserts the *default* posture is honest.
    for (const [capability, command] of Object.entries(CAPABILITY_OBLIGATIONS)) {
      if (args[capability] !== true) continue;
      expect(conn.handledReverseRequests()).toContain(command);
    }
    // And the pairing itself: every obligation names a real reverse request.
    for (const command of Object.values(CAPABILITY_OBLIGATIONS)) {
      expect(REVERSE_REQUESTS).toContain(command as ReverseRequest);
    }
  });

  it("claims variable paging, which the tree now does", () => {
    // Held back through Phase 3 on purpose: an unbacked claim about what the
    // client can render is the same class of lie as one about what it serves.
    // `debugVariables.ts` sends `start` and `count`, so it is declared.
    expect(args.supportsVariablePaging).toBe(true);
    expect(args.supportsVariableType).toBe(true);
  });

  it("does not claim runInTerminal, which Tori refuses", () => {
    // Phase 1 measured this: with `integratedTerminal` or `externalTerminal`
    // js-debug sends `runInTerminal`, and a session that cannot serve it dies
    // at zero stops, zero output and zero errors. Declaring false keeps the
    // adapter off that path in the first place.
    expect(args.supportsRunInTerminalRequest).toBe(false);
  });
});
