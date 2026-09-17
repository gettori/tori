import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { gateMet, deriveView } = await import("./firstRun");

const space = (name: string) => ({ name, path: `/p/${name}`, projects: [] });

describe("the gate", () => {
  it("is unmet with no config, no root, or a root with nothing under it", () => {
    expect(gateMet(null)).toBe(false);
    expect(gateMet({ roots: [], spaces: [] })).toBe(false);
    expect(gateMet({ roots: ["/p"], spaces: [] })).toBe(false);
    expect(gateMet({ roots: [], spaces: [space("work")] })).toBe(false);
  });

  it("is met by a root with one space in it", () => {
    expect(gateMet({ roots: ["/p"], spaces: [space("work")] })).toBe(true);
  });
});

describe("the view", () => {
  const base = { loaded: true, introSeen: true, opened: true, finished: false };

  it("stays shut until both backend answers have landed", () => {
    expect(deriveView({ ...base, loaded: false })).toBe("closed");
  });

  it("shows the intro first, then setup", () => {
    expect(deriveView({ ...base, introSeen: false })).toBe("intro");
    expect(deriveView(base)).toBe("setup");
  });

  it("never opens for a user whose gate was met all along", () => {
    expect(deriveView({ ...base, opened: false })).toBe("closed");
  });

  it("stays on setup after the gate is met inside it, until Open Tori", () => {
    // `opened` is the latch: the gate flipping true does not clear it.
    expect(deriveView({ ...base, opened: true })).toBe("setup");
    expect(deriveView({ ...base, finished: true })).toBe("closed");
  });
});
