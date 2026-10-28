import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

type Handler = (e: { id?: string; error?: string }) => void;
const handlers = new Map<string, Handler>();
const speak = vi.fn();
const stopEngine = vi.fn();
let nextId = 0;

vi.mock("tauri-plugin-tts-api", () => ({
  MAX_TEXT_LENGTH: 10_000,
  isTtsError: (e: unknown) => typeof e === "object" && e !== null && "code" in e && "message" in e,
  onSpeechEvent: async (type: string, h: Handler) => {
    handlers.set(type, h);
    return () => {};
  },
  speak: (o: unknown) => speak(o),
  getVoices: () => getVoices(),
  stop: () => stopEngine(),
}));

const getVoices = vi.fn();
const speechSettings = vi.hoisted(() => ({ speech: { rate: 1, voice: null as string | null } }));
const saveSettings = vi.hoisted(() => vi.fn(async (_s: unknown) => {}));
vi.mock("../panels/Settings/settingsStore", () => ({ settings: speechSettings, saveSettings }));

const emitWith = vi.fn();
vi.mock("./events", () => ({ TOAST: "toast", emitWith: (...a: unknown[]) => emitWith(...a) }));

const { changeRate, read, readSelection, readingBlockOf, stop, reading, splitToFit } = await import("./speech");

const fire = (type: string, id?: string, error?: string) => handlers.get(`speech:${type}`)?.({ id, error });
const texts = () => speak.mock.calls.map(([o]) => (o as { text: string }).text);
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("speech", () => {
  beforeEach(async () => {
    stopEngine.mockResolvedValue(undefined);
    await stop();
    speak.mockReset().mockImplementation(async () => ({ success: true, utteranceId: `u${nextId++}` }));
    stopEngine.mockReset().mockResolvedValue(undefined);
    emitWith.mockReset();
    getVoices.mockReset().mockResolvedValue([{ id: "daniel", name: "Daniel", language: "en-GB" }]);
    speechSettings.speech = { rate: 1, voice: null };
  });

  it("queues every chunk up front, the first flushing and the rest appended", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
        { text: "three", block: 2 },
      ],
      "r1",
    );
    expect(texts()).toEqual(["one", "two", "three"]);
    expect(speak.mock.calls.map(([o]) => (o as { queueMode: string }).queueMode)).toEqual(["flush", "add", "add"]);
  });

  it("follows the start events block by block and goes idle after the last finish", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
      ],
      "r1",
    );
    const [a, b] = await Promise.all(speak.mock.results.map((r) => r.value as Promise<{ utteranceId: string }>));
    expect(reading()).toEqual({ source: "r1", block: 0 });
    fire("finish", a.utteranceId);
    fire("start", b.utteranceId);
    expect(reading()).toEqual({ source: "r1", block: 1 });
    expect(readingBlockOf("r1")).toBe(1);
    expect(readingBlockOf("r2")).toBeUndefined();
    fire("finish", b.utteranceId);
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
    const old = await (speak.mock.results[1].value as Promise<{ utteranceId: string }>);
    await read(
      [
        { text: "new", block: 0 },
        { text: "new two", block: 1 },
      ],
      "r2",
    );
    fire("start", old.utteranceId);
    fire("finish", old.utteranceId);
    expect(reading()).toEqual({ source: "r2", block: 0 });
  });

  it("goes idle and toasts when the engine refuses", async () => {
    speak.mockRejectedValueOnce({ code: "TTS_ENGINE_ERROR", message: "no engine" });
    await read([{ text: "one" }], "r1");
    expect(reading()).toBeNull();
    expect(emitWith).toHaveBeenCalledWith(
      "toast",
      expect.objectContaining({ kind: "error", message: expect.stringContaining("no engine") }),
    );
  });

  it("splits an 11,000 byte chunk into several under the cap", async () => {
    const text = "This is a sentence of plain words. ".repeat(315);
    expect(bytes(text)).toBeGreaterThan(11_000);
    await read([{ text, block: 0 }], "r1");
    expect(texts().length).toBeGreaterThan(1);
    for (const t of texts()) expect(bytes(t)).toBeLessThanOrEqual(10_000);
    expect(texts().join("")).toBe(text);
  });

  it("counts the cap in UTF-8 bytes, so a Bengali paragraph is split too", () => {
    const text = "আমি বাংলায় কথা বলি। ".repeat(200).slice(0, 4000);
    expect(text.length).toBe(4000);
    const parts = splitToFit(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(10_000);
    expect(parts.join("")).toBe(text);
  });

  it("splits a 15,000 byte selection with no blank lines under the cap", async () => {
    const text = "A line of a PDF page, no blank line after.\n".repeat(350);
    expect(bytes(text)).toBeGreaterThan(15_000);
    await readSelection(text);
    expect(texts().length).toBeGreaterThan(1);
    for (const t of texts()) expect(bytes(t)).toBeLessThanOrEqual(10_000);
  });

  it("speaks every chunk at the set rate and in the set voice", async () => {
    speechSettings.speech = { rate: 1.4, voice: "daniel" };
    await read([{ text: "one" }, { text: "two" }], "r1");
    for (const [o] of speak.mock.calls) expect(o).toMatchObject({ rate: 1.4, voiceId: "daniel" });
  });

  it("falls back to the system voice when the set one is no longer installed", async () => {
    speechSettings.speech = { rate: 1, voice: "removed" };
    await read([{ text: "one" }], "r1");
    expect((speak.mock.calls[0][0] as { voiceId?: string }).voiceId).toBeUndefined();
  });

  it("queues again from the chunk being spoken when the speed changes mid read", async () => {
    await read(
      [
        { text: "one", block: 0 },
        { text: "two", block: 1 },
        { text: "three", block: 2 },
      ],
      "r1",
    );
    const second = await (speak.mock.results[1].value as Promise<{ utteranceId: string }>);
    fire("start", second.utteranceId);
    speak.mockClear();

    await changeRate(1.5);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ speech: { rate: 1.5, voice: null } }));
    expect(speak.mock.calls.map(([o]) => o)).toEqual([
      expect.objectContaining({ text: "two", queueMode: "flush", rate: 1.5 }),
      expect.objectContaining({ text: "three", queueMode: "add", rate: 1.5 }),
    ]);
    expect(reading()).toEqual({ source: "r1", block: 1 });
  });
});
