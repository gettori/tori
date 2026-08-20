import { describe, expect, it, afterEach } from "vitest";
import {
  clearDraftPick,
  draftPick,
  hasPick,
  pickRidesArgv,
  resetDraftPick,
  setDraftPick,
} from "./chatDraftPick";

const TAB = "chat:pick-1";

afterEach(() => clearDraftPick(TAB));

describe("a draft's pick", () => {
  it("is the CLI's own defaults until something is picked", () => {
    expect(draftPick(TAB)).toEqual({ model: null, mode: null, effort: null });
    expect(hasPick(draftPick(TAB))).toBe(false);
  });

  it("patches one field without disturbing the rest", () => {
    setDraftPick(TAB, { model: "sonnet" });
    setDraftPick(TAB, { effort: "high" });
    expect(draftPick(TAB)).toEqual({ model: "sonnet", mode: null, effort: "high" });
    expect(hasPick(draftPick(TAB))).toBe(true);
  });

  // Mode and effort name things the old agent published, so carrying them across
  // would spawn the new one with flags it never declared.
  it("drops mode and effort when the agent changes", () => {
    setDraftPick(TAB, { model: "sonnet", mode: "plan", effort: "high" });
    resetDraftPick(TAB, "gpt-5");
    expect(draftPick(TAB)).toEqual({ model: "gpt-5", mode: null, effort: null });
  });

  it("is forgotten when the tab is", () => {
    setDraftPick(TAB, { model: "sonnet" });
    clearDraftPick(TAB);
    expect(draftPick(TAB).model).toBeNull();
  });

  it("keeps tabs apart", () => {
    setDraftPick(TAB, { model: "sonnet" });
    setDraftPick("chat:pick-2", { model: "haiku" });
    expect(draftPick(TAB).model).toBe("sonnet");
    clearDraftPick("chat:pick-2");
  });
});

describe("how a pick reaches the session", () => {
  // Claude spells a model as `--model`, so the session that answers the
  // handshake is already running it.
  it("rides the argv for a claude-shaped transport", () => {
    expect(pickRidesArgv("claude_stream_json")).toBe(true);
  });

  // Every ACP adapter declares `model_args = []` and refuses a model before its
  // session exists, so the pick is a request made after the session opens.
  it("does not for ACP", () => {
    expect(pickRidesArgv("acp")).toBe(false);
  });

  // An adapter that has not resolved yet is not ACP, and treating it as if it
  // were would hold a first message waiting for a request nothing will make.
  it("treats an unresolved transport as argv", () => {
    expect(pickRidesArgv(undefined)).toBe(true);
  });
});
