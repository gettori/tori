import { describe, expect, it } from "vitest";
import { amendRewritesPushed, composeCommitMessage, splitCommitMessage } from "./commitMessage";

describe("composeCommitMessage", () => {
  it("joins subject and body with one blank line", () => {
    expect(composeCommitMessage("add the thing", "because reasons")).toBe("add the thing\n\nbecause reasons");
  });

  it("yields the subject alone when the body is empty or blank", () => {
    expect(composeCommitMessage("add the thing", "")).toBe("add the thing");
    expect(composeCommitMessage("add the thing", "   \n  ")).toBe("add the thing");
  });

  it("trims both fields, so stray whitespace never reaches git", () => {
    expect(composeCommitMessage("  subject  ", "  body  ")).toBe("subject\n\nbody");
  });
});

describe("splitCommitMessage", () => {
  it("splits on the first blank line", () => {
    expect(splitCommitMessage("subject\n\nbody")).toEqual({ subject: "subject", body: "body" });
  });

  it("treats a message with no blank line as all subject", () => {
    expect(splitCommitMessage("just a subject")).toEqual({ subject: "just a subject", body: "" });
  });

  it("keeps later paragraph breaks in the body rather than splitting again", () => {
    expect(splitCommitMessage("subject\n\nfirst\n\nsecond")).toEqual({
      subject: "subject",
      body: "first\n\nsecond",
    });
  });

  it("normalises CRLF, so a message written on Windows still splits", () => {
    expect(splitCommitMessage("subject\r\n\r\nbody")).toEqual({ subject: "subject", body: "body" });
  });

  it("round-trips a multi-paragraph message through compose", () => {
    const message = "subject\n\nfirst\n\nsecond";
    const { subject, body } = splitCommitMessage(message);
    expect(composeCommitMessage(subject, body)).toBe(message);
  });
});

describe("amendRewritesPushed", () => {
  it("warns when HEAD is contained in the upstream", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 0, has_upstream: true })).toBe(true);
  });

  it("stays quiet when there are unpushed commits on top", () => {
    expect(amendRewritesPushed({ ahead: 2, behind: 0, has_upstream: true })).toBe(false);
  });

  it("stays quiet without an upstream: nothing to rewrite for anyone else", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 0, has_upstream: false })).toBe(false);
  });

  it("stays quiet when the state is unknown", () => {
    expect(amendRewritesPushed(null)).toBe(false);
  });

  it("warns even when behind, since being behind says nothing about HEAD", () => {
    expect(amendRewritesPushed({ ahead: 0, behind: 3, has_upstream: true })).toBe(true);
  });
});
