import { describe, it, expect } from "vite-plus/test";
import { holdingTab, refusalMessage, refusalOf, type ClaimOutcome } from "./chatOwnership";

describe("refusalOf", () => {
  it("treats a grant as no refusal, contested or not", () => {
    expect(refusalOf({ type: "granted", contested: false })).toBeNull();
    // A contested grant is still a grant: the session did open, and the warning
    // is a toast, not a refusal that would disable the composer.
    expect(refusalOf({ type: "granted", contested: true })).toBeNull();
  });

  it("is null for a claim that has not resolved yet", () => {
    expect(refusalOf(null)).toBeNull();
    expect(refusalOf(undefined)).toBeNull();
  });

  it("narrows every refusal so its own fields are readable", () => {
    const held: ClaimOutcome = { type: "heldByOther", surface: "ptyAgent", tabId: "sh:1" };
    expect(refusalOf(held)).toEqual(held);
  });
});

describe("refusalMessage", () => {
  it("names the surface that holds it, because 'already open' alone is not actionable", () => {
    expect(refusalMessage({ type: "heldByOther", surface: "ptyAgent", tabId: "t" })).toContain("terminal tab");
    expect(refusalMessage({ type: "heldByOther", surface: "chat", tabId: "t" })).toContain("chat");
    expect(refusalMessage({ type: "alreadyMineFocus", tabId: "t" })).toContain("another tab");
  });

  it("says an orphan has to end, since focusing it is not an option", () => {
    expect(refusalMessage({ type: "orphaned", childPid: 42 })).toContain("has to end");
  });
});

describe("holdingTab", () => {
  it("names the tab to focus when a tab is what holds the session", () => {
    expect(holdingTab({ type: "alreadyMineFocus", tabId: "sh:1" })).toBe("sh:1");
    expect(holdingTab({ type: "heldByOther", surface: "chat", tabId: "chat:9" })).toBe("chat:9");
  });

  it("has nothing to focus for an orphan, which is a bare process", () => {
    expect(holdingTab({ type: "orphaned", childPid: 42 })).toBeNull();
  });
});
