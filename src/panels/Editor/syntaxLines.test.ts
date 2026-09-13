import { describe, it, expect } from "vitest";
import { languageForPath, tokenLines } from "./syntaxLines";

describe("tokenLines", () => {
  it("puts the editor's classes on the right lines", async () => {
    const lang = (await languageForPath("/repo/a.ts"))!;
    const lines = tokenLines('const x = "hi";\nreturn x;', lang);
    expect(lines).toHaveLength(2);
    expect(lines[0].find((s) => s.text === "const")?.cls).toBe("sy-keyword");
    expect(lines[0].find((s) => s.text === '"hi"')?.cls).toBe("sy-string");
    expect(lines[1].find((s) => s.text === "return")?.cls).toBe("sy-control");
    // Every character comes back, in order, so a caller can cut the spans by
    // offset into the original text.
    expect(lines.map((l) => l.map((s) => s.text).join("")).join("\n")).toBe('const x = "hi";\nreturn x;');
  });

  it("keeps a multi-line comment one colour across its lines", async () => {
    const lang = (await languageForPath("/repo/a.ts"))!;
    const lines = tokenLines("/* one\ntwo */\nlet y = 1;", lang);
    expect(lines[0]).toEqual([{ text: "/* one", cls: "sy-comment" }]);
    expect(lines[1]).toEqual([{ text: "two */", cls: "sy-comment" }]);
    expect(lines[2].find((s) => s.text === "let")?.cls).toBe("sy-keyword");
  });

  it("hands back one span list per line, blank lines included", async () => {
    const lang = (await languageForPath("/repo/a.ts"))!;
    expect(tokenLines("a\n\nb", lang).map((l) => l.length)).toEqual([1, 0, 1]);
    expect(tokenLines("", lang)).toEqual([[]]);
  });
});
