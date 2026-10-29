import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

const backend = vi.hoisted(() => ({
  start: null as null | { kind: string; error?: string },
  stop: { kind: "silent" } as { kind: string; error?: string; text?: string },
  release: null as null | (() => void),
}));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === "dictation_start" && backend.start) throw backend.start;
    if (cmd === "dictation_stop") {
      await new Promise<void>((resolve) => (backend.release = resolve));
      if (backend.stop.kind === "failed") throw backend.stop;
      return backend.stop;
    }
    return undefined;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { toggle, dropActive, state, seconds, PERMISSION_HELP } = await import("./dictation");
const { TOAST, onWith } = await import("./events");

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const stopped = async () => {
  await settled();
  backend.release?.();
  backend.release = null;
  await settled();
};

let toasts: { message: string }[] = [];
let off = () => {};

beforeEach(() => {
  backend.start = null;
  backend.stop = { kind: "silent" };
  backend.release = null;
  invoke.mockClear();
  toasts = [];
  off = onWith<{ message: string }>(TOAST, (t) => toasts.push(t));
  dropActive();
});

afterEach(() => off());

describe("dictation", () => {
  it("records on one press, transcribes on the next, and ignores a press while transcribing", async () => {
    const insert = vi.fn();
    await toggle(insert);
    expect(state()).toBe("recording");
    expect(seconds()).toBe(0);

    backend.stop = { kind: "text", text: "hello there" };
    const finishing = toggle(insert);
    await settled();
    expect(state()).toBe("transcribing");
    await toggle(insert);
    expect(invoke.mock.calls.filter(([c]) => c === "dictation_start")).toHaveLength(1);

    backend.release?.();
    await finishing;
    expect(insert).toHaveBeenCalledWith("hello there");
    expect(state()).toBe("idle");
  });

  it("inserts nothing and says nothing for a clip that stayed quiet", async () => {
    const insert = vi.fn();
    await toggle(insert);
    const finishing = toggle(insert);
    await stopped();
    await finishing;
    expect(insert).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(state()).toBe("idle");
  });

  it("points at System Settings when the microphone is refused", async () => {
    backend.start = { kind: "permission" };
    await toggle(vi.fn());
    expect(toasts.map((t) => t.message)).toEqual([PERMISSION_HELP]);
    expect(state()).toBe("idle");
  });

  it("toasts a transcription that failed", async () => {
    const insert = vi.fn();
    await toggle(insert);
    backend.stop = { kind: "failed", error: "the model file is gone" };
    const finishing = toggle(insert);
    await stopped();
    await finishing;
    expect(toasts.map((t) => t.message)).toEqual(["Couldn't transcribe: the model file is gone"]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("drops a recording on Escape without inserting", async () => {
    const insert = vi.fn();
    expect(dropActive()).toBe(false);
    await toggle(insert);
    expect(dropActive()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("dictation_cancel");
    expect(state()).toBe("idle");
    expect(insert).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});
