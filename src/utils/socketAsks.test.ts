import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(true) }));

import { asksFor, closeAsk, showAsk } from "./socketAsks";

describe("socketAsks", () => {
  it("drops a card answered from another session", () => {
    showAsk({ id: "ask-1", session: "w1", question: "which?", options: [] });
    showAsk({ id: "ask-2", session: "w1", question: "and?", options: [] });
    expect(asksFor("w1").map((a) => a.id)).toEqual(["ask-1", "ask-2"]);
    closeAsk("ask-1");
    expect(asksFor("w1").map((a) => a.id)).toEqual(["ask-2"]);
  });
});
