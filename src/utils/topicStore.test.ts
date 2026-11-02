import { describe, it, expect, vi } from "vite-plus/test";
import type { Topic } from "./topics";

const pending = vi.hoisted(() => [] as ((list: unknown) => void)[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => new Promise((resolve) => pending.push(resolve)),
}));

const { reloadTopics, topics } = await import("./topicStore");

const topic = (id: string): Topic => ({ id, name: id, branch: id, members: [], createdAt: 0 });

describe("reloadTopics", () => {
  it("keeps the later request's answer when an earlier one resolves after it", async () => {
    const first = reloadTopics();
    const second = reloadTopics();
    pending[1]([topic("new")]);
    await second;
    pending[0]([topic("old")]);
    await first;
    expect(topics().map((t) => t.id)).toEqual(["new"]);
  });
});
