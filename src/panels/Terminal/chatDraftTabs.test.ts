import { describe, it, expect } from "vitest";
import { canRevertToDraft, isChatDraft, type OpenTerm } from "./terminalTabStore";

// Which chat tabs are drafts, and which of them may become one again. Both are
// read off the tab record rather than a flag, so these pin the two structural
// questions the chat stage and the failure path ask.

const chat = (over: Partial<OpenTerm> = {}): OpenTerm => ({
  id: "chat:1",
  title: "repo",
  cwd: "/work/repo",
  workspace: "/work/repo",
  kind: "chat",
  program: "claude",
  args: [],
  ...over,
});

describe("isChatDraft", () => {
  it("calls a chat tab with no session a draft", () => {
    expect(isChatDraft(chat())).toBe(true);
  });

  it("stops calling it one the moment it has a session", () => {
    expect(isChatDraft(chat({ sessionId: "s1" }))).toBe(false);
  });

  // A shell or agent tab has a program running in it whether or not it carries a
  // session id, so the same absence means something entirely different there.
  it("never calls a tab of another kind a draft", () => {
    expect(isChatDraft(chat({ kind: "shell" }))).toBe(false);
    expect(isChatDraft(chat({ kind: "agent" }))).toBe(false);
  });
});

describe("canRevertToDraft", () => {
  it("lets a plain new chat go back to being a draft", () => {
    expect(canRevertToDraft(chat({ sessionId: "s1" }))).toBe(true);
  });

  // The lineage is the reason those tabs were opened. Silently dropping it would
  // turn "replay this conversation" into "here is an empty chat", which reads as
  // the fork having worked.
  it("refuses for a fork, whose replayed history a draft cannot represent", () => {
    expect(canRevertToDraft(chat({ sessionId: "s2", forkFrom: "s1" }))).toBe(false);
  });

  it("refuses for a rewind, which is a fork with a cut", () => {
    expect(canRevertToDraft(chat({ sessionId: "s2", forkFrom: "s1", rewindTo: 1699 }))).toBe(false);
  });

  it("refuses for a resume, whose conversation already exists on disk", () => {
    expect(canRevertToDraft(chat({ sessionId: "s1", resume: true }))).toBe(false);
  });
});
