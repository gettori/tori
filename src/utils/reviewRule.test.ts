import { describe, expect, it } from "vite-plus/test";
import { spawnMode } from "./reviewRule";

describe("spawnMode", () => {
  it("opens a read-only spawn of claude in plan mode", () => {
    expect(spawnMode(null, true, "claude")).toBe("plan");
  });

  it("keeps an agent with no read-only mode on its usual pick", () => {
    expect(spawnMode(null, true, "codex")).toBeNull();
  });

  it("leaves an ordinary spawn and an asked mode alone", () => {
    expect(spawnMode(null, false, "claude")).toBeNull();
    expect(spawnMode("acceptEdits", true, "claude")).toBe("acceptEdits");
  });
});
