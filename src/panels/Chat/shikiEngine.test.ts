// The real engine, real grammars, no mocks: the theme maps TextMate scopes it
// never sees named in our own code, so only tokenizing actual source proves
// the mapping holds. The diff case exists because it shipped unmapped once -
// the grammar loaded fine and every line fell through to the default color.
import { describe, it, expect, beforeAll } from "vitest";
import { init, canHighlight, isLoaded, loadLang, toHtml } from "./shikiEngine";

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

  it("paints code through the syntax roles, not literal colors", () => {
    const html = toHtml("const x = 'hi'", "ts");
    expect(html).toContain("var(--syntax-keyword)");
    expect(html).toContain("var(--syntax-string)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
