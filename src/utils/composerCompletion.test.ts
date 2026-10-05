import { describe, it, expect } from "vite-plus/test";
import { activeToken, dropToken, moveIndex, rank, replaceToken, MAX_COMPLETIONS } from "./composerCompletion";

describe("activeToken", () => {
  it("finds a file mention at the start and after a space", () => {
    expect(activeToken("@src", 4)).toEqual({ kind: "file", query: "src", start: 0, end: 4 });
    expect(activeToken("look at @src", 12)).toEqual({ kind: "file", query: "src", start: 8, end: 12 });
  });

  it("opens on the bare sigil, so the menu appears before anything is typed", () => {
    expect(activeToken("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
  });

  // An email address or a decorator is not a file mention, and offering the
  // project index over one would be noise on every address ever typed.
  it("ignores an @ that is not at a word boundary", () => {
    expect(activeToken("mail me@example", 15)).toBeNull();
  });

  it("closes once the mention is followed by a space", () => {
    expect(activeToken("@src/a.ts done", 14)).toBeNull();
  });

  it("reads the token at the caret, not at the end of the text", () => {
    expect(activeToken("@src and more", 4)).toEqual({ kind: "file", query: "src", start: 0, end: 4 });
    // Caret inside the trailing prose: no menu, even though an @ exists behind.
    expect(activeToken("@src and more", 13)).toBeNull();
  });

  it("completes a slash command only as the message's opening", () => {
    expect(activeToken("/pla", 4)).toEqual({ kind: "command", query: "pla", start: 0, end: 4 });
    // Mid-sentence, a slash is a path separator, not a command.
    expect(activeToken("look in src/uti", 15)).toBeNull();
  });

  it("prefers the token nearest the caret when both are present", () => {
    expect(activeToken("/plan @sr", 9)).toEqual({ kind: "file", query: "sr", start: 6, end: 9 });
  });

  it("has nothing to complete in empty or plain text", () => {
    expect(activeToken("", 0)).toBeNull();
    expect(activeToken("just words", 10)).toBeNull();
  });
});

describe("rank", () => {
  const files = ["src/utils/chatCompose.ts", "src/panels/Chat/Composer.tsx", "README.md"];

  it("orders by fuzzy score and drops what does not match", () => {
    expect(rank(files, "compose", (f) => f)).toEqual([
      "src/utils/chatCompose.ts",
      "src/panels/Chat/Composer.tsx",
    ]);
  });

  it("keeps source order for an empty query", () => {
    expect(rank(files, "", (f) => f)).toEqual(files);
  });

  it("caps what a menu has to render", () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    expect(rank(many, "src", (f) => f)).toHaveLength(MAX_COMPLETIONS);
  });
});

describe("replaceToken and dropToken", () => {
  it("replaces a command token with the command and puts the caret after it", () => {
    const token = activeToken("/pla", 4)!;
    expect(replaceToken("/pla", token, "/plan ")).toEqual({ text: "/plan ", caret: 6 });
  });

  it("keeps whatever followed the token", () => {
    const token = activeToken("/pla", 4)!;
    expect(replaceToken("/pla rest", token, "/plan ")).toEqual({ text: "/plan  rest", caret: 6 });
  });

  // A file mention becomes a chip, so its text has to go - without leaving the
  // double space that a naive splice would.
  it("removes a file token and the space it was sitting in", () => {
    const token = activeToken("look at @src", 12)!;
    expect(dropToken("look at @src", token)).toEqual({ text: "look at", caret: 7 });
  });

  it("rejoins the two sides when the mention was in the middle", () => {
    const token = activeToken("see @src ok", 8)!;
    expect(dropToken("see @src ok", token)).toEqual({ text: "see ok", caret: 3 });
  });

  it("empties the input when the mention was all of it", () => {
    const token = activeToken("@src", 4)!;
    expect(dropToken("@src", token)).toEqual({ text: "", caret: 0 });
  });
});

describe("moveIndex", () => {
  it("wraps at both ends", () => {
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
  });

  it("stays at zero when there is nothing to move through", () => {
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});
