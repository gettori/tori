import { describe, expect, it } from "vite-plus/test";
import { spendView } from "./spend";

describe("how a spend reads", () => {
  it("prints dollars for an agent that reports them", () => {
    expect(spendView({ tokens: 9, costUsd: 4.5, turns: 3 }, "this branch")).toEqual({
      text: "$4.50",
      says: "$4.50 spent on this branch across 3 turns",
    });
  });

  it("prints turns and says no cost was reported for one that reports none", () => {
    const view = spendView({ tokens: 0, costUsd: null, turns: 12 }, "this item");
    expect(view?.text).toBe("12 turns");
    expect(view?.says).toMatch(/no cost reported/);
  });

  it("prints nothing when nothing was recorded", () => {
    expect(spendView(null, "x")).toBeNull();
    expect(spendView({ tokens: 0, costUsd: null, turns: 0 }, "x")).toBeNull();
  });
});
