// The server-initiated requests Tori answers itself.
//
// `LSPClient.receiveMessage` replies to every server-initiated *request* with
// `-32601 MethodNotFound` (`lsp-client/dist/index.js:684-690`) and offers an
// extension point for notifications only, so a request this client owes an
// answer to has to be caught on the transport, before the library sees it. A
// -32601 is not fatal, but it tells a conformant server that the client lied in
// its capabilities, and rust-analyzer's response to that is to stop asking -
// which is precisely the feature being asked for.
//
// One router rather than a chain of hand-rolled `interceptX` functions: every
// capability declared from here on owes an answer on this same seam, and the
// second hand-rolled interceptor is where the rules below quietly stop being
// followed.
//
// Two rules, both load-bearing:
//
//   1. **Substring before parse.** Every frame from a busy server would
//      otherwise be `JSON.parse`d twice, once here and once by the library, for
//      messages that arrive a handful of times a session.
//   2. **A synchronous handler answers synchronously.** Deferring even one
//      microtask would change when the reply reaches the wire relative to
//      everything else the transport does, and the refresh path is asserted at
//      exactly that granularity.

/** JSON-RPC's own code for "the handler blew up". */
const INTERNAL_ERROR = -32603;

/**
 * Answers one server-initiated request.
 *
 * Returning a value answers `result`; returning a promise answers when it
 * settles; returning nothing answers `null`, which is what a request with no
 * meaningful result expects. Throwing or rejecting answers an error, so a
 * handler never has to build a JSON-RPC frame itself.
 *
 * `ctx` is whatever identifies the session the frame arrived on. Generic
 * rather than a bare root string on purpose: sessions are keyed by
 * `(server id, root)` and two servers can resolve the same root, so a handler
 * that needs to find its session back must be handed enough to do it.
 */
export type ServerRequestHandler<Ctx> = (params: unknown, ctx: Ctx) => unknown;

/** Whether the frame was consumed. A `false` means the library still has to
 *  see it. */
export type RequestRouter<Ctx> = (ctx: Ctx, msg: string, send: (message: string) => void) => boolean;

type Frame = { id?: unknown; method?: unknown; params?: unknown };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

function resultFrame(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null });
}

function errorFrame(id: unknown, e: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: String(e) } });
}

/**
 * Build a router over `handlers`, keyed by LSP method name. A key of the form
 * `eslint/*` answers every method in that namespace that has no key of its own.
 *
 * The returned function is what the transport calls for every inbound frame.
 */
export function createRequestRouter<Ctx>(handlers: Record<string, ServerRequestHandler<Ctx>>): RequestRouter<Ctx> {
  const methods = Object.keys(handlers).map((m) => (m.endsWith("/*") ? m.slice(0, -1) : m));

  return (ctx, msg, send) => {
    // Rule 1. Cheap for the overwhelming majority of frames, which name none of
    // these methods.
    if (!methods.some((method) => msg.includes(method))) return false;

    let frame: Frame;
    try {
      frame = JSON.parse(msg) as Frame;
    } catch {
      return false;
    }

    // Only the request form. A notification-shaped frame, or a *response* that
    // merely mentions the method name, is the library's to deal with: replying
    // to something that carries no id would put a response with `"id":
    // undefined` on the wire.
    if (typeof frame.method !== "string" || frame.id === undefined) return false;
    const handler =
      handlers[frame.method] ?? handlers[`${frame.method.slice(0, frame.method.indexOf("/") + 1)}*`];
    if (!handler) return false;

    const { id } = frame;
    let answer: unknown;
    try {
      answer = handler(frame.params, ctx);
    } catch (e) {
      send(errorFrame(id, e));
      return true;
    }
    // Rule 2. The branch matters: awaiting a synchronous answer would defer it
    // by a microtask for no reason.
    if (isThenable(answer)) {
      answer.then(
        (result) => send(resultFrame(id, result)),
        (e: unknown) => send(errorFrame(id, e)),
      );
    } else {
      send(resultFrame(id, answer));
    }
    return true;
  };
}
