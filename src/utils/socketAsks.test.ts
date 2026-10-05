import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(true) }));

import { answerAsk, asksFor, closeAsk, showAsk } from "./socketAsks";

describe("socketAsks", () => {
  it("drops a card answered from another session", () => {
    showAsk({ id: "ask-1", session: "w1", question: "which?", options: [] });
    showAsk({ id: "ask-2", session: "w1", question: "and?", options: [] });
    expect(asksFor("w1").map((a) => a.id)).toEqual(["ask-1", "ask-2"]);
    closeAsk("ask-1");
    expect(asksFor("w1").map((a) => a.id)).toEqual(["ask-2"]);
  });

  it("shows a mirrored approval in both panels, and one answer clears both", async () => {
    showAsk({
      id: "ask-3",
      session: "worker",
      question: "open it?",
      options: ["Approve", "Reject"],
      shown_in: ["worker", "autopilot"],
    });
    expect(asksFor("worker").map((a) => a.id)).toContain("ask-3");
    expect(asksFor("autopilot").map((a) => a.id)).toEqual(["ask-3"]);
    await answerAsk("ask-3", "Approve");
    expect(asksFor("worker").map((a) => a.id)).not.toContain("ask-3");
    expect(asksFor("autopilot")).toEqual([]);
  });
});
