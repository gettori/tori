import { describe, expect, it } from "vitest";
import { queuedItems, workerCards, type ItemRow } from "./autopilotRows";

const row = (over: Partial<ItemRow>): ItemRow => ({
  id: "i1",
  kind: "ship",
  source: { type: "issue", key: "12", project: "/code/tori" },
  project: "/code/tori",
  state: "running",
  created: 1,
  updated: 1,
  ...over,
});

describe("item titles", () => {
  it("shows the autopilot's title and the contract on the card", () => {
    const [card] = workerCards([row({ title: "Fix the login redirect", contract: "Build: the redirect." })]);
    expect(card.title).toBe("Fix the login redirect");
    expect(card.contract).toBe("Build: the redirect.");
  });

  it("falls back to the kind and project when there is no title", () => {
    expect(workerCards([row({ title: null })])[0].title).toBe("Ship in tori");
    expect(queuedItems([row({ state: "queued", kind: "review" })])[0].title).toBe("Review in tori");
  });
});
