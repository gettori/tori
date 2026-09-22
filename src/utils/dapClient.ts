// The wire half of a debug session: one connection to one adapter, de-framed
// messages in and out.
//
// Deliberately transport-agnostic. It is handed a `send` and fed inbound
// messages through `receive`, so `dapSessions.ts` owns the Tauri Channel and
// this file is drivable by a test with two function calls. Nothing here imports
// CodeMirror or Solid: the debugger's protocol layer is eager, and pulling the
// editor into it would drag CodeMirror into the startup chunk.
//
// DAP is not LSP, and the two differences that cost real time both live here:
//
//   1. **Correlation is on `request_seq`, never `seq`.** Both sides run their
//      own `seq` counter, so a response's own `seq` has nothing to do with the
//      request it answers. Correlating on `seq` looks right for the first
//      exchange of a session and then silently pairs the wrong answers.
//   2. **Reverse requests are not capability-gated.** js-debug issues them off
//      the launch config rather than off what the client declared, so a name
//      with no router entry is a request nobody answers and an adapter that
//      waits forever. Every name the bundle can send therefore has an entry
//      from birth, and the four Tori cannot serve are *refused* explicitly
//      rather than left silent.
//
// Unlike `serverRequests.ts` there is no substring-before-parse rule: LSP's
// router sees every frame of a chatty server and skips the parse for the ones
// it cannot own, whereas here parsing is unconditional anyway because responses
// and events dispatch out of the same switch.

/** Identifies one session, i.e. one connection to one adapter process.
 *  Produced by the backend; the frontend only ever holds and returns it. */
export type DapHandle = { server: string; session: string };

/** A request the adapter sent *us*. Tori owes every one of these an answer. */
export type DapRequestFrame = { seq: number; type: "request"; command: string; arguments?: unknown };

/**
 * Every reverse request `vscode-js-debug` can send, sorted.
 *
 * The authoritative list is `expect.reverseRequests` in
 * `src-tauri/resources/dap/manifest.json`, which `scripts/install-dap.mjs`
 * rediscovers *structurally* from the bundle on every install. This constant is
 * asserted equal to it, so bumping the adapter to a version that added a sixth
 * name fails the suite here until it has a handler, rather than at runtime as a
 * session that hangs with nothing logged.
 */
export const REVERSE_REQUESTS = [
  "launchUnelevated",
  "launchVSCode",
  "remoteFileExists",
  "runInTerminal",
  "startDebugging",
] as const;

export type ReverseRequest = (typeof REVERSE_REQUESTS)[number];

/**
 * Why Tori refuses each reverse request it does not serve.
 *
 * A refusal is an answer: the adapter learns the client cannot do this and
 * reports a real failure, instead of the Phase 1 symptom where an unanswered
 * `runInTerminal` left the session at zero stops, zero output and zero errors.
 * `startDebugging` is here too so an unwired connection refuses rather than
 * hangs; `dapSessions.ts` overrides it with the real handler.
 */
const REFUSALS: Record<ReverseRequest, string> = {
  launchUnelevated: "Tori does not relaunch debug targets with elevated privileges.",
  launchVSCode: "Tori is not VS Code and cannot open a VS Code window.",
  remoteFileExists: "Tori does not debug over a remote connection.",
  runInTerminal:
    "Tori runs debug targets in its own debug console; use `console: \"internalConsole\"`.",
  startDebugging: "This debug connection has no child-session handler.",
};

/** Base for the `id` of a refusal's structured error. DAP leaves the numbering
 *  to whoever produces the message, so these are Tori's own and stable. */
const REFUSAL_ERROR_BASE = 1000;

/**
 * The `initialize` arguments every session sends.
 *
 * `linesStartAt1` and `columnsStartAt1` are the Phase 1 convention, proven by
 * TDZ probes on line-named locals rather than by reading a number back, and
 * pinned by a test: flipping either silently moves every breakpoint, stack
 * frame and current-line highlight by one.
 */
export function initializeArguments(adapterId: string, childSessions: boolean): Record<string, unknown> {
  return {
    clientID: "tori",
    clientName: "Tori",
    adapterID: adapterId,
    locale: "en",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
    // Rendering only: what the variables tree shows, not a request Tori owes.
    // `supportsVariablePaging` was held back until the tree that sends `start`
    // and `count` existed, because an unbacked claim about what the client can
    // do is the same class of lie the obligations map below exists to stop,
    // whichever direction it points in. `debugVariables.ts` sends them now, so
    // it is declared.
    supportsVariableType: true,
    supportsVariablePaging: true,
    // The two that oblige an answer. See CAPABILITY_OBLIGATIONS. A child
    // session is a second connection to the same adapter, which only an
    // adapter with `child_sessions` takes.
    supportsRunInTerminalRequest: false,
    supportsStartDebuggingRequest: childSessions,
  };
}

/**
 * Client capabilities whose truth obliges Tori to *serve* a reverse request.
 *
 * Declaring one of these true while refusing the request it names is a lie the
 * adapter believes, and js-debug believing it is how a target ends up launched
 * into a terminal that does not exist. A test asserts the pairing holds, which
 * is the whole reason the map is data rather than prose. Capabilities absent
 * from here (`supportsVariableType` and friends) describe what Tori renders and
 * carry no inbound request.
 */
export const CAPABILITY_OBLIGATIONS: Record<string, ReverseRequest> = {
  supportsRunInTerminalRequest: "runInTerminal",
  supportsStartDebuggingRequest: "startDebugging",
};

/** Answers one reverse request. Returning a value answers `success: true` with
 *  that body; returning a promise answers when it settles; throwing or
 *  rejecting answers `success: false`. */
export type ReverseRequestHandler = (args: unknown, frame: DapRequestFrame) => unknown;

export type DapConnection = {
  /** Feed one de-framed inbound message, exactly as the backend delivered it. */
  receive(message: string): void;
  /** Send a request and resolve with its `body`, or reject with its `message`. */
  request<T = unknown>(command: string, args?: unknown): Promise<T>;
  /** Subscribe to an adapter event. Every subscriber is called; returns an
   *  unsubscribe. */
  on(event: string, handler: (body: unknown) => void): () => void;
  /** Replace the handler for one reverse request. */
  onReverse(command: ReverseRequest, handler: ReverseRequestHandler): void;
  /** Which reverse requests this connection can answer. */
  handledReverseRequests(): ReverseRequest[];
  /** Whether `command` is answered by a refusal rather than served. */
  refuses(command: ReverseRequest): boolean;
  /** Reject everything in flight and ignore everything that arrives after.
   *  What a session going away calls, so no caller is left awaiting a reply
   *  that can no longer come. */
  dispose(reason: string): void;
};

type Pending = { resolve: (value: never) => void; reject: (e: unknown) => void };

type Frame = {
  type?: unknown;
  seq?: unknown;
  event?: unknown;
  command?: unknown;
  body?: unknown;
  arguments?: unknown;
  request_seq?: unknown;
  success?: unknown;
  message?: unknown;
};

/**
 * What a failed response actually said.
 *
 * DAP puts the human-readable text in `body.error.format`, and `message` is
 * only "a short machine-readable id". js-debug 1.117 sends **no `message` at
 * all**: an unresolvable expression answers
 * `body.error.format: "Uncaught ReferenceError: notAName is not defined"` and
 * nothing else, so reading `message` first turned every failure in the app into
 * the word "failed". Measured, not assumed.
 *
 * `{name}` placeholders are filled from `variables` the way the spec defines,
 * because a leaked `{path}` in a message under someone's cursor is worse than
 * no message.
 */
function failureText(frame: Frame): string {
  const error = (frame.body as { error?: { format?: unknown; variables?: unknown } } | undefined)
    ?.error;
  const format = typeof error?.format === "string" ? error.format : null;
  if (format) {
    const vars = error?.variables;
    if (!vars || typeof vars !== "object") return format;
    const table = vars as Record<string, unknown>;
    return format.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in table ? String(table[name]) : whole,
    );
  }
  return String(frame.message ?? "failed");
}

function refusalFor(command: ReverseRequest): { message: string; body: unknown } {
  return {
    message: REFUSALS[command],
    body: {
      error: {
        id: REFUSAL_ERROR_BASE + REVERSE_REQUESTS.indexOf(command),
        format: REFUSALS[command],
        // Tori already surfaces the failure in the debug console; a modal from
        // the adapter's own message would be the same thing twice.
        showUser: false,
      },
    },
  };
}

/** Open a protocol client over an already-connected transport. */
export function createDapConnection(send: (message: string) => void): DapConnection {
  let seq = 1;
  let disposed: string | null = null;
  const pending = new Map<number, Pending>();
  const events = new Map<string, ((body: unknown) => void)[]>();
  const reverse = new Map<ReverseRequest, ReverseRequestHandler>();
  // Which entries are still the built-in refusal. Read by the capability test,
  // which cares about served-vs-refused and not merely about presence.
  const refused = new Set<ReverseRequest>(REVERSE_REQUESTS);

  for (const command of REVERSE_REQUESTS) {
    reverse.set(command, () => {
      const { message, body } = refusalFor(command);
      throw new DapRefusal(message, body);
    });
  }

  function write(frame: Record<string, unknown>): void {
    send(JSON.stringify({ seq: seq++, ...frame }));
  }

  function respond(frame: DapRequestFrame, success: boolean, body: unknown, message?: string): void {
    write({
      type: "response",
      request_seq: frame.seq,
      command: frame.command,
      success,
      ...(body === undefined ? {} : { body }),
      ...(message === undefined ? {} : { message }),
    });
  }

  function answer(frame: DapRequestFrame, handler: ReverseRequestHandler): void {
    let result: unknown;
    try {
      result = handler(frame.arguments, frame);
    } catch (e) {
      respond(frame, false, bodyOfError(e), String(messageOfError(e)));
      return;
    }
    // The branch matters: awaiting a synchronous answer would defer it by a
    // microtask, and `startDebugging` is answered before its child is started
    // precisely so the adapter is never left waiting on us.
    if (isThenable(result)) {
      result.then(
        (body) => respond(frame, true, body),
        (e: unknown) => respond(frame, false, bodyOfError(e), String(messageOfError(e))),
      );
    } else {
      respond(frame, true, result);
    }
  }

  function dispatch(frame: Frame): void {
    if (frame.type === "response") {
      // Correlation is on `request_seq`. See the header.
      const waiter = pending.get(frame.request_seq as number);
      if (!waiter) return;
      pending.delete(frame.request_seq as number);
      if (frame.success === true) waiter.resolve(frame.body as never);
      else waiter.reject(new Error(`${String(frame.command)}: ${failureText(frame)}`));
      return;
    }

    if (frame.type === "event") {
      const name = String(frame.event);
      // A copy: a subscriber is allowed to unsubscribe from inside its own call,
      // which is what a one-shot `initialized` listener does.
      for (const handler of [...(events.get(name) ?? [])]) {
        try {
          handler(frame.body);
        } catch (e) {
          console.warn("debug event handler failed", name, e);
        }
      }
      return;
    }

    if (frame.type === "request") {
      const request = frame as DapRequestFrame;
      const handler = reverse.get(request.command as ReverseRequest);
      if (!handler) {
        // Unreachable through a bundle `dap:install` accepted, since that check
        // discovers the names structurally. Answered anyway: an unanswered
        // request is an adapter that waits forever.
        console.warn("debug adapter sent an unknown reverse request", request.command);
        respond(request, false, undefined, `Tori does not implement \`${request.command}\`.`);
        return;
      }
      if (refused.has(request.command as ReverseRequest)) {
        console.warn("debug adapter requested", request.command, "which Tori refuses");
      }
      answer(request, handler);
    }
  }

  return {
    receive(message) {
      if (disposed) return;
      let frame: Frame;
      try {
        frame = JSON.parse(message) as Frame;
      } catch (e) {
        console.warn("unparseable debug adapter frame", e);
        return;
      }
      dispatch(frame);
    },

    request<T>(command: string, args?: unknown): Promise<T> {
      if (disposed) return Promise.reject(new Error(`${command}: ${disposed}`));
      const mine = seq;
      // Registered *before* the write. The executor runs synchronously, so this
      // costs nothing, and it means a transport that ever answers without
      // yielding cannot deliver a response to a request that is not yet
      // waiting for one.
      const answer = new Promise<T>((resolve, reject) => {
        pending.set(mine, { resolve: resolve as (value: never) => void, reject });
      });
      try {
        write({ type: "request", command, arguments: args ?? {} });
      } catch (e) {
        // A transport that fails to accept the frame leaves nothing that could
        // ever answer it, so the entry has to come back out: left behind, the
        // caller waits on a reply that cannot arrive.
        pending.delete(mine);
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return answer;
    },

    on(event, handler) {
      events.set(event, [...(events.get(event) ?? []), handler]);
      return () => {
        events.set(event, (events.get(event) ?? []).filter((h) => h !== handler));
      };
    },

    onReverse(command, handler) {
      reverse.set(command, handler);
      refused.delete(command);
    },

    handledReverseRequests() {
      return [...reverse.keys()].sort();
    },

    refuses(command) {
      return refused.has(command);
    },

    dispose(reason) {
      if (disposed) return;
      disposed = reason;
      for (const waiter of pending.values()) waiter.reject(new Error(reason));
      pending.clear();
      events.clear();
    },
  };
}

/** A refusal carrying the structured `body` DAP wants alongside the text. */
class DapRefusal extends Error {
  constructor(
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

function bodyOfError(e: unknown): unknown {
  return e instanceof DapRefusal ? e.body : undefined;
}

function messageOfError(e: unknown): unknown {
  return e instanceof Error ? e.message : e;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}
