// `tracedCore` stands in for `@tauri-apps/api/core` in the production build, so
// every invoke in the app goes through it. The vite plugin that installs it is
// build-only, which means no other suite ever executes this file's body: a
// regression in argument passing or error propagation would ship unseen.

import { describe, it, expect, vi, afterEach } from "vite-plus/test";

const realInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => realInvoke(...a) }));

const { invoke, setInvokeRecorder } = await import("./tracedCore");

afterEach(() => {
  setInvokeRecorder(null);
  realInvoke.mockReset();
});

describe("tracedCore", () => {
  it("passes the call through untouched when nothing is recording", async () => {
    realInvoke.mockResolvedValue("ok");
    await expect(invoke("cmd", { a: 1 })).resolves.toBe("ok");
    expect(realInvoke).toHaveBeenCalledWith("cmd", { a: 1 }, undefined);
  });

  it("sends the arguments the recorder returns, not the caller's", async () => {
    realInvoke.mockResolvedValue(null);
    setInvokeRecorder((_cmd, args) => ({ args: { ...(args as object), tag: 7 }, done: () => {} }));
    await invoke("cmd", { a: 1 });
    expect(realInvoke).toHaveBeenCalledWith("cmd", { a: 1, tag: 7 }, undefined);
  });

  it("declines to touch a call the recorder passes on", async () => {
    realInvoke.mockResolvedValue(null);
    setInvokeRecorder(() => undefined);
    await invoke("trace_write", { lines: [] });
    expect(realInvoke).toHaveBeenCalledWith("trace_write", { lines: [] }, undefined);
  });

  it("closes the record once the call answers", async () => {
    realInvoke.mockResolvedValue("v");
    const done = vi.fn();
    setInvokeRecorder((_c, args) => ({ args, done }));
    await invoke("cmd");
    expect(done).toHaveBeenCalledOnce();
  });

  // The failure path matters more than the happy one: a wrapper that swallowed
  // a rejection would break every caller's error handling at once.
  it("closes the record and still rejects when the call fails", async () => {
    realInvoke.mockRejectedValue(new Error("boom"));
    const done = vi.fn();
    setInvokeRecorder((_c, args) => ({ args, done }));
    await expect(invoke("cmd")).rejects.toThrow("boom");
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps the options argument", async () => {
    realInvoke.mockResolvedValue(null);
    const opts = { headers: {} };
    await invoke("cmd", { a: 1 }, opts);
    expect(realInvoke).toHaveBeenCalledWith("cmd", { a: 1 }, opts);
  });
});
