import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let reply: (cmd: string) => Promise<unknown> = () => Promise.resolve(null);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return reply(cmd);
  },
}));

const { saveQueue, dropQueue, loadQueue } = await import("./queuePersist");

const text = (id: string, t: string) => ({ id, blocks: [{ type: "text" as const, text: t }] });

beforeEach(() => {
  calls.length = 0;
  reply = () => Promise.resolve(null);
});

describe("the saved queue", () => {
  it("writes in order even when the first save answers late", async () => {
    let finishFirst!: () => void;
    reply = () => (calls.length === 1 ? new Promise((r) => (finishFirst = () => r(null))) : Promise.resolve(null));
    const first = saveQueue("s-order", [text("q1", "a"), text("q2", "b")]);
    const second = saveQueue("s-order", [text("q2", "b")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    finishFirst();
    await Promise.all([first, second]);
    expect(calls.map((c) => (c.args.queue as unknown[]).length)).toEqual([2, 1]);
  });

  it("drops the file after a save still in flight when the tab closes", async () => {
    let finishSave!: () => void;
    reply = () => (calls.length === 1 ? new Promise((r) => (finishSave = () => r(null))) : Promise.resolve(null));
    const save = saveQueue("s-close", [text("q1", "a")]);
    const drop = dropQueue("s-close");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    finishSave();
    await Promise.all([save, drop]);
    expect(calls[calls.length - 1].args.queue).toEqual([]);
  });

  it("keeps a queued pull request reference across a relaunch", async () => {
    const entry = {
      id: "q1",
      blocks: [
        {
          type: "ref" as const,
          label: "[PR 7]",
          target: {
            kind: "pr" as const,
            number: 7,
            title: "Seven",
            url: "https://github.com/o/r/pull/7",
            state: "open",
            draft: false,
            head: "h",
            base: "main",
          },
        },
        { type: "text" as const, text: "look at [PR 7]" },
      ],
    };
    await saveQueue("s-ref", [entry]);
    const saved = calls[calls.length - 1].args.queue;
    reply = () => Promise.resolve(saved);
    expect(await loadQueue("s-ref")).toEqual([entry]);
  });

  it("never writes or restores a steer in flight", async () => {
    await saveQueue("s-steer", [{ ...text("q1", "a"), steering: true }]);
    expect(calls[0].args.queue).toEqual([text("q1", "a")]);
    reply = () => Promise.resolve([{ ...text("q1", "a"), steering: true }, { nonsense: 1 }]);
    expect(await loadQueue("s-steer")).toEqual([text("q1", "a")]);
  });
});
