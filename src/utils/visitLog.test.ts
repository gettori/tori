import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import { loadVisits, MAX_VISITS, noteVisit, recentPlaces, withVisit } from "./visitLog";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("visitLog", () => {
  it("puts a visit first once and caps the log", () => {
    expect(withVisit(["b", "a", "c"], "a")).toEqual(["a", "b", "c"]);
    const full = Array.from({ length: MAX_VISITS }, (_, i) => `p${i}`);
    const next = withVisit(full, "new");
    expect(next).toHaveLength(MAX_VISITS);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`p${MAX_VISITS - 1}`);
  });

  it("resolves keys against the live places, dropping the current one and any that are gone", () => {
    const places = [{ id: "unit:/w/a a" }, { id: "topic:t1" }, { id: "chat:c1" }];
    expect(recentPlaces(["chat:c1", "unit:/w/gone gone", "unit:/w/a a", "topic:t1"], places, "topic:t1")).toEqual([
      { id: "chat:c1" },
      { id: "unit:/w/a a" },
    ]);
  });

  it("keeps the log across loads", () => {
    noteVisit("unit:/w/a a");
    noteVisit("topic:t1");
    noteVisit("unit:/w/a a");
    expect(loadVisits()).toEqual(["unit:/w/a a", "topic:t1"]);
  });
});
