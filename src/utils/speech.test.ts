import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

type SpeechEvent = { kind: string; read: number; chunk?: number; error?: string };
let handler: ((e: { payload: SpeechEvent }) => void) | undefined;
const speak = vi.fn();
const stopEngine = vi.fn();
let nextId = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => (cmd === "speech_speak" ? speak(args) : stopEngine()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, h: typeof handler) => {
    handler = h;
    return () => {};
  },
}));

const speechSettings = vi.hoisted(() => ({ speech: { rate: 1, voice: null as string | null } }));
const saveSettings = vi.hoisted(() => vi.fn(async (_s: unknown) => {}));
vi.mock("../panels/Settings/settingsStore", () => ({ settings: speechSettings, saveSettings }));

const emitWith = vi.fn();
vi.mock("./events", () => ({ TOAST: "toast", emitWith: (...a: unknown[]) => emitWith(...a) }));

const { changeRate, preview, read, readSelection, readingBlockOf, stop, reading } = await import("./speech");

type Speak = { chunks: string[]; rate: number; voice: string | null };
const fire = (kind: string, read: number, chunk?: number, error?: string) =>
  handler?.({ payload: { kind, read, chunk, error } });
const calls = () => speak.mock.calls.map(([o]) => o as Speak);
const lastId = () => speak.mock.results[speak.mock.results.length - 1].value as Promise<number>;

describe("speech", () => {
  beforeEach(async () => {
    stopEngine.mockResolvedValue(undefined);
    await stop();
    speak.mockReset().mockImplementation(async () => nextId++);
    stopEngine.mockReset().mockResolvedValue(undefined);
    emitWith.mockReset();
    speechSettings.speech = { rate: 1, voice: null };
  });

  it("hands every chunk over in one read, in order", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
        { text: "three", block: 2 },
      ],
      "r1",
    );
    expect(calls().map((c) => c.chunks)).toEqual([["one", "two", "three"]]);
  });

  it("follows the start events block by block and goes idle after the last finish", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
      ],
      "r1",
    );
    const id = await lastId();
    expect(reading()).toEqual({ source: "r1", block: 0 });
    fire("start", id, 0);
    fire("finish", id, 0);
    fire("start", id, 1);
    expect(reading()).toEqual({ source: "r1", block: 1 });
    expect(readingBlockOf("r1")).toBe(1);
    expect(readingBlockOf("r2")).toBeUndefined();
    fire("finish", id, 1);
    expect(reading()).toBeNull();
  });

  it("ignores events from a read that a newer one replaced", async () => {
    await read(
      [
        { text: "old", block: 0 },
        { text: "old two", block: 1 },
      ],
      "r1",
    );
    const old = await lastId();
    await read(
      [
        { text: "new", block: 0 },
        { text: "new two", block: 1 },
      ],
      "r2",
    );
    fire("start", old, 1);
    fire("finish", old, 1);
    fire("cancel", old);
    expect(reading()).toEqual({ source: "r2", block: 0 });
  });

  it("goes idle and toasts when the engine refuses", async () => {
    speak.mockRejectedValueOnce("No voice is downloaded");
    await read([{ text: "one" }], "r1");
    expect(reading()).toBeNull();
    expect(emitWith).toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ kind: "error", message: expect.stringContaining("No voice is downloaded") }),
    );
  });

  it("goes idle and toasts on an error event mid read", async () => {
    await read([{ text: "one" }, { text: "two" }], "r1");
    fire("error", await lastId(), undefined, "no audio output");
    expect(reading()).toBeNull();
    expect(emitWith).toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ message: expect.stringContaining("no audio output") }),
    );
  });

  it("goes idle when the engine cancels the read, as closing the window does", async () => {
    await read([{ text: "one" }, { text: "two" }], "r1");
    fire("cancel", await lastId());
    expect(reading()).toBeNull();
  });

  it("previews a voice, naming the preview when it fails", async () => {
    speak.mockRejectedValueOnce("No voice is downloaded");
    await preview("am_michael", "a sample");
    expect(calls()[0]).toMatchObject({ chunks: ["a sample"], voice: "am_michael" });
    expect(emitWith).toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ message: expect.stringContaining("Couldn't play the voice") }),
    );
  });

  it("leaves a long chunk whole for the engine to split", async () => {
    const text = "This is a sentence of plain words. ".repeat(315);
    await read([{ text, block: 0 }], "r1");
    expect(calls()[0].chunks).toEqual([text]);
  });

  it("reads a selection paragraph by paragraph", async () => {
    await readSelection("first\n\nsecond");
    expect(calls()[0].chunks).toEqual(["first", "second"]);
  });

  it("reads at the set rate and in the set voice", async () => {
    speechSettings.speech = { rate: 1.4, voice: "bf_emma" };
    await read([{ text: "one" }, { text: "two" }], "r1");
    expect(calls()[0]).toMatchObject({ rate: 1.4, voice: "bf_emma" });
  });

  it("reads again from the chunk being spoken when the speed changes mid read", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
        { text: "three", block: 2 },
      ],
      "r1",
    );
    fire("start", await lastId(), 1);
    speak.mockClear();

    await changeRate(1.5);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ speech: { rate: 1.5, voice: null } }));
    expect(calls()).toEqual([expect.objectContaining({ chunks: ["two", "three"], rate: 1.5 })]);
    expect(reading()).toEqual({ source: "r1", block: 1 });

    const again = await lastId();
    fire("start", again, 1);
    expect(reading()).toEqual({ source: "r1", block: 2 });
    fire("finish", again, 1);
    expect(reading()).toBeNull();
  });

  it("stops the engine after a read still being handed over, and goes idle", async () => {
    const order: string[] = [];
    speak.mockImplementationOnce(async () => {
      order.push("speak");
      return nextId++;
    });
    stopEngine.mockImplementationOnce(async () => order.push("stop"));
    void read([{ text: "one" }], "r1");
    await stop();
    expect(order).toEqual(["speak", "stop"]);
    expect(reading()).toBeNull();
  });
});
