// The real engine, real grammars, no mocks: the theme maps TextMate scopes it
// never sees named in our own code, so only tokenizing actual source proves
// the mapping holds. The diff case exists because it shipped unmapped once -
// the grammar loaded fine and every line fell through to the default color.
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { init, canHighlight, isLoaded, loadLang, toHtml, toLines } from "./shikiEngine";

const DIFF = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-const old = 1;", "+const fresh = 1;"].join("\n");

beforeAll(async () => {
  await init();
  await loadLang("diff");
  await loadLang("ts");
});

describe("the chat highlighter engine", () => {
  it("answers whether a fence's info string names a grammar, aliases included", () => {
    expect(canHighlight("ts")).toBe(true);
    expect(canHighlight("diff")).toBe(true);
    expect(canHighlight("not-a-language")).toBe(false);
    expect(isLoaded("diff")).toBe(true);
  });

  it("paints diff lines and their markers with the transcript's hunk roles", () => {
    const html = toHtml(DIFF, "diff");
    expect(html).toContain("var(--diff-added)");
    expect(html).toContain("var(--diff-deleted)");
    // Headers and the hunk range recede rather than fall through to default.
    expect(html).toContain("var(--fg-muted)");
  });

  // A body that puts a gutter or a diff marker beside a line needs the lines
  // already separated, and tokenizing the block whole is what keeps a comment
  // spanning several lines coloured as the one thing it is.
  it("gives one line of HTML per line, with a multi-line construct still whole", () => {
    const lines = toLines("/* one\n   two */\nconst x = 1;", "ts");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("var(--syntax-comment)");
    expect(lines[1]).toContain("var(--syntax-comment)");
    expect(lines[2]).toContain("var(--syntax-keyword)");
    // Nothing may reach the DOM as markup that was not markup in the source.
    expect(toLines("const a = b < c && d > e;", "ts").join("")).not.toContain("<c");
  });

  it("paints code through the syntax roles, not literal colors", () => {
    const html = toHtml("const x = 'hi'", "ts");
    expect(html).toContain("var(--syntax-keyword)");
    expect(html).toContain("var(--syntax-string)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
