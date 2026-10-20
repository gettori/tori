import { describe, it, expect } from "vite-plus/test";
import { addressOf, keeperOf, type Seen } from "./collapse";

const tab = (over: Partial<Seen>): Seen => ({ windowId: 1, ...over });

it("reads the pending address of a tab another app opened", () => {
  expect(addressOf(tab({ id: 2, url: "", pendingUrl: "http://localhost:5173/" }))).toBe("http://localhost:5173/");
});

describe("keeperOf", () => {
  const created = tab({ id: 9, pendingUrl: "http://localhost:5173/" });

  it("picks the most recently used other tab on the port, on any local host", () => {
    const tabs = [
      created,
      tab({ id: 1, url: "http://localhost:5173/a", lastAccessed: 10 }),
      tab({ id: 2, url: "http://127.0.0.1:5173/b", lastAccessed: 30 }),
      tab({ id: 3, url: "http://localhost:3000/", lastAccessed: 50 }),
    ];
    expect(keeperOf(created, tabs, 5173)?.id).toBe(2);
  });

  it("finds none when the new tab is the only one on the port", () => {
    expect(keeperOf(created, [created, tab({ id: 3, url: "http://localhost:3000/" })], 5173)).toBeUndefined();
  });
});
