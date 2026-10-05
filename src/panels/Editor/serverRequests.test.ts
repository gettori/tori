import { describe, it, expect } from "vite-plus/test";
import { createRequestRouter } from "./serverRequests";

// The router sits on the transport, in front of a library that answers -32601
// to everything. What matters is the two things it must not get wrong: consume
// only what it can actually answer, and answer a synchronous handler without
// deferring - the frame ordering on the wire is observable.

const METHOD = "workspace/applyEdit";
const ROOT = "/repo";

function collector() {
  const sent: unknown[] = [];
  return { sent, send: (message: string) => sent.push(JSON.parse(message)) };
}

const request = (method: string, id: unknown = 1, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("createRequestRouter", () => {
  it("answers a synchronous handler on the same tick", () => {
    // Not a style preference: the refresh path's tests assert the reply is on
    // the wire immediately after the frame arrives, with no await in between.
    const c = collector();
    const router = createRequestRouter({ [METHOD]: () => ({ applied: true }) });

    expect(router(ROOT, request(METHOD, 7), c.send)).toBe(true);
    expect(c.sent).toEqual([{ jsonrpc: "2.0", id: 7, result: { applied: true } }]);
  });

  it("answers null when the handler returns nothing", () => {
    const c = collector();
    const router = createRequestRouter({ [METHOD]: () => {} });

    router(ROOT, request(METHOD, 2), c.send);

    expect(c.sent).toEqual([{ jsonrpc: "2.0", id: 2, result: null }]);
  });

  it("waits for an async handler, then answers", async () => {
    const c = collector();
    let release: (v: unknown) => void = () => {};
    const router = createRequestRouter({
      [METHOD]: () => new Promise((r) => (release = r)),
    });

    expect(router(ROOT, request(METHOD, 3), c.send)).toBe(true);
    expect(c.sent, "nothing answered while the handler is still working").toEqual([]);

    release({ applied: false });
    await Promise.resolve();

    expect(c.sent).toEqual([{ jsonrpc: "2.0", id: 3, result: { applied: false } }]);
  });

  it("hands the handler the params and the session root", () => {
    const seen: unknown[] = [];
    const router = createRequestRouter({
      [METHOD]: (params, root) => void seen.push([params, root]),
    });

    router(ROOT, request(METHOD, 4, { edit: { changes: {} } }), collector().send);

    expect(seen).toEqual([[{ edit: { changes: {} } }, ROOT]]);
  });

  it("turns a throwing handler into an error frame rather than an unanswered request", () => {
    // An unanswered request leaves the server parked on its own timeout.
    const c = collector();
    const router = createRequestRouter({
      [METHOD]: () => {
        throw new Error("nope");
      },
    });

    expect(router(ROOT, request(METHOD, 5), c.send)).toBe(true);
    expect(c.sent).toMatchObject([{ id: 5, error: { code: -32603 } }]);
  });

  it("turns a rejecting handler into an error frame too", async () => {
    const c = collector();
    const router = createRequestRouter({ [METHOD]: () => Promise.reject(new Error("nope")) });

    router(ROOT, request(METHOD, 6), c.send);
    await Promise.resolve();
    await Promise.resolve();

    expect(c.sent).toMatchObject([{ id: 6, error: { code: -32603 } }]);
  });
});

describe("createRequestRouter leaves alone what is not its business", () => {
  const router = createRequestRouter({ [METHOD]: () => null });

  it("passes a method it does not handle straight through", () => {
    const c = collector();
    expect(router(ROOT, request("textDocument/publishDiagnostics", 1), c.send)).toBe(false);
    expect(c.sent).toEqual([]);
  });

  it("passes a notification through, since replying would put an undefined id on the wire", () => {
    const c = collector();
    const notification = JSON.stringify({ jsonrpc: "2.0", method: METHOD, params: {} });

    expect(router(ROOT, notification, c.send)).toBe(false);
    expect(c.sent).toEqual([]);
  });

  it("passes through a frame that merely mentions the method name", () => {
    const c = collector();
    const logMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "window/logMessage",
      params: { message: `${METHOD} handled` },
    });

    expect(router(ROOT, logMessage, c.send)).toBe(false);
    expect(c.sent).toEqual([]);
  });

  it("survives a frame that is not JSON at all", () => {
    const c = collector();
    expect(() => router(ROOT, METHOD, c.send)).not.toThrow();
    expect(router(ROOT, METHOD, c.send)).toBe(false);
  });

  it("routes each method to its own handler", () => {
    const seen: string[] = [];
    const two = createRequestRouter({
      [METHOD]: () => void seen.push("apply"),
      "workspace/codeLens/refresh": () => void seen.push("lens"),
    });

    two(ROOT, request("workspace/codeLens/refresh", 1), collector().send);
    two(ROOT, request(METHOD, 2), collector().send);

    expect(seen).toEqual(["lens", "apply"]);
  });
});
