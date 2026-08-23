// The heavy half of chat syntax highlighting, reached only through
// `highlight.ts`'s dynamic import so none of shiki lands in the eager bundle
// (the boundary test pins that). Grammars load per language on first sight.
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

const THEME = "sway-chat";

// TextMate scopes onto the theme's `--syntax-*` roles, so chat code follows a
// theme switch live (the vars repaint) instead of needing a re-highlight.
const swayTheme: ThemeRegistration = {
  name: THEME,
  settings: [
    { settings: { foreground: "var(--fg-default)", background: "var(--neutral-subtle)" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "var(--syntax-string)" } },
    { scope: "constant.character.escape", settings: { foreground: "var(--syntax-escape)" } },
    { scope: ["string.regexp", "constant.regexp"], settings: { foreground: "var(--syntax-regexp)" } },
    { scope: "constant.numeric", settings: { foreground: "var(--syntax-number)" } },
    {
      scope: ["constant.language", "support.constant", "variable.other.constant"],
      settings: { foreground: "var(--syntax-constant)" },
    },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "var(--syntax-keyword)" } },
    { scope: "keyword.control", settings: { foreground: "var(--syntax-control)" } },
    { scope: "keyword.operator", settings: { foreground: "var(--syntax-operator)" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--syntax-function)" } },
    { scope: "entity.name.function.member", settings: { foreground: "var(--syntax-method)" } },
    {
      scope: ["entity.name.type", "entity.name.type.alias", "support.type"],
      settings: { foreground: "var(--syntax-type)" },
    },
    {
      scope: ["entity.name.class", "entity.name.type.class", "support.class"],
      settings: { foreground: "var(--syntax-class)" },
    },
    {
      scope: ["entity.name.namespace", "entity.name.type.module"],
      settings: { foreground: "var(--syntax-namespace)" },
    },
    { scope: "variable", settings: { foreground: "var(--syntax-variable)" } },
    { scope: "variable.parameter", settings: { foreground: "var(--syntax-parameter)" } },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.type.property-name",
        "meta.object-literal.key",
      ],
      settings: { foreground: "var(--syntax-property)" },
    },
    { scope: "entity.name.tag", settings: { foreground: "var(--syntax-tag)" } },
    { scope: "entity.other.attribute-name", settings: { foreground: "var(--syntax-attribute)" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "var(--syntax-punctuation)" } },
    { scope: "markup.heading", settings: { foreground: "var(--syntax-keyword)" } },
    { scope: ["markup.bold", "markup.italic"], settings: { foreground: "var(--syntax-constant)" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "var(--syntax-string)" } },
    { scope: "markup.quote", settings: { foreground: "var(--syntax-comment)" } },
    { scope: "markup.underline.link", settings: { foreground: "var(--syntax-attribute)" } },
    // The diff grammar's vocabulary, on the roles the transcript's tool-call
    // hunks already paint with, so a fenced diff and a real hunk read the
    // same. The markers carry their own deeper punctuation scope, which would
    // otherwise beat the line scope and paint the +/- as plain punctuation.
    {
      scope: ["markup.inserted", "punctuation.definition.inserted"],
      settings: { foreground: "var(--diff-added)" },
    },
    {
      scope: ["markup.deleted", "punctuation.definition.deleted"],
      settings: { foreground: "var(--diff-deleted)" },
    },
    {
      scope: ["markup.changed", "punctuation.definition.changed"],
      settings: { foreground: "var(--diff-modified)" },
    },
    {
      scope: [
        "meta.diff",
        "punctuation.definition.range.diff",
        "punctuation.definition.from-file.diff",
        "punctuation.definition.to-file.diff",
      ],
      settings: { foreground: "var(--fg-muted)" },
    },
  ],
};

let hl: HighlighterCore | undefined;

export async function init(): Promise<void> {
  hl ??= await createHighlighterCore({
    themes: [swayTheme],
    langs: [],
    // The JS engine over oniguruma: no wasm compile step, and `forgiving`
    // degrades an unsupported grammar construct to unstyled text instead of
    // throwing away the whole block.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
}

/** Whether a fence's info string names a grammar shiki ships (aliases included). */
export function canHighlight(name: string): boolean {
  return name in bundledLanguages;
}

// Tracked by requested key rather than via getLoadedLanguages(): the key may be
// an alias of a grammar already registered under its canonical name.
const loaded = new Set<string>();

export function isLoaded(name: string): boolean {
  return loaded.has(name);
}

export async function loadLang(name: string): Promise<void> {
  await hl!.loadLanguage(bundledLanguages[name as keyof typeof bundledLanguages]);
  loaded.add(name);
}

/** Token spans only (`structure: "inline"`): the chat owns the `<pre><code>`
 *  frame, shiki supplies the colors. */
export function toHtml(code: string, name: string): string {
  return hl!.codeToHtml(code, { lang: name, theme: THEME, structure: "inline" });
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/**
 * The same colours, one string of HTML per line.
 *
 * `toHtml` cannot serve a body that puts anything beside a line, because a
 * gutter or a `+` marker has to live outside the highlighted run and there is
 * no safe place to cut its output. Tokenizing gives the lines already
 * separated, and the whole block is still tokenized at once, so a comment or a
 * string spanning several lines is coloured as the one thing it is.
 */
export function toLines(code: string, name: string): string[] {
  const { tokens } = hl!.codeToTokens(code, { lang: name, theme: THEME });
  return tokens.map((line) =>
    line.map((t) => `<span style="color:${t.color ?? "inherit"}">${escape(t.content)}</span>`).join(""),
  );
}
