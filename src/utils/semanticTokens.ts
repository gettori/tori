// What a language server means by "this run of characters is a parameter", and
// how that arrives on the wire.
//
// A grammar can only see shape. `foo` in `f(foo)` and `foo` in `{ foo: 1 }` are
// the same three characters to Lezer, so lexical highlighting has to guess, and
// `CodeEditor`'s `t.local(t.variableName)` rule was that guess. A server has
// actually resolved the program, so it can say which is a parameter, which is a
// property of an imported type, and which is a deprecated method.
//
// The answer comes back as one flat array of unsigned integers, five per token,
// every number relative to the token before it, and every meaning an index into
// a legend the server declared at `initialize` time. So there are three separate
// things here and none of them needs an editor:
//
//   * the capability block that asks for any of this at all;
//   * the legend, which turns an index into a name;
//   * the decoder, which turns the deltas back into absolute positions.
//
// Kept CodeMirror-free for the same reason `symbols.ts` is: `Editor.tsx` sits on
// the eager side of the lazy `CodeEditor` boundary, and a runtime
// `@codemirror/*` import in `utils/` is how the editor's ~1.3 MB graph gets back
// into the startup chunk. The half that makes decorations out of these lives in
// `panels/Editor/semanticHighlight.ts`.

/** The token types Tori asks for, in the spec's own spelling.
 *
 *  A server is free to answer with types outside this list (rust-analyzer has a
 *  dozen of its own) and that is fine: mapping is by name, so an unrecognised
 *  one simply gets no colour of its own and keeps whatever the grammar gave it.
 *  What the list is really for is the opposite direction, telling a server which
 *  standard types are worth computing. */
export const TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
] as const;

/** The modifiers Tori asks for. Only `deprecated` currently changes how a token
 *  renders; the rest are decoded and carried so a later rule can use them
 *  without another round of protocol work. */
export const TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
] as const;

/**
 * The capability block, as an `LSPClientExtension` entry.
 *
 * `augmentsSyntaxTokens: true` is the honest description of what Tori does with
 * the answer: the grammar keeps highlighting everything it can see, and these
 * land on top of it. A client that claimed otherwise would be asking servers to
 * tokenise punctuation and comments Tori already colours.
 *
 * `workspace.semanticTokens.refreshSupport` is the one server-initiated request
 * this app invites, deliberately and against the rule that governs the rest of
 * the capability surface. Semantic colour depends on the whole program: editing
 * `types.ts` changes what a name in `main.ts` *means* without changing a
 * character of it, and the refresh notification is the only way a server can say
 * so. It is answered in `lspClient.ts`'s transport rather than by the library,
 * which replies `-32601` to every request it did not expect. `workspace
 * .configuration` and `didChangeWatchedFiles.dynamicRegistration` stay absent
 * for exactly the reason this one is present: nothing here answers them.
 */
export const semanticTokensClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      semanticTokens: {
        dynamicRegistration: false,
        // "relative" is the only format the spec defines, and the only one the
        // decoder below implements.
        formats: ["relative"],
        requests: { full: true },
        tokenTypes: [...TOKEN_TYPES],
        tokenModifiers: [...TOKEN_MODIFIERS],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
        serverCancelSupport: false,
        augmentsSyntaxTokens: true,
      },
    },
    workspace: {
      semanticTokens: { refreshSupport: true },
    },
  },
};

// -------------------------------------------------------------------- legend

/** What the numbers in a response mean. Declared once by the server, at
 *  `initialize`, and every token in every later response is indexed against it.
 *  Read it wrong and the file is confidently coloured as the wrong things. */
export type SemanticLegend = { types: string[]; modifiers: string[] };

/**
 * The legend out of a server's `semanticTokensProvider`, or null when there is
 * none to have.
 *
 * Null is a first-class answer, not a failure: a server with no semantic tokens
 * at all lands here, and so does one whose provider is malformed. Both mean the
 * file keeps its lexical colours, which is what it has today.
 */
export function legendFrom(provider: unknown): SemanticLegend | null {
  if (!provider || typeof provider !== "object") return null;
  const legend = (provider as { legend?: unknown }).legend;
  if (!legend || typeof legend !== "object") return null;
  const { tokenTypes, tokenModifiers } = legend as {
    tokenTypes?: unknown;
    tokenModifiers?: unknown;
  };
  if (!Array.isArray(tokenTypes)) return null;
  return {
    types: tokenTypes.map(String),
    // A server may legitimately define no modifiers at all, which is an empty
    // list rather than a missing legend.
    modifiers: Array.isArray(tokenModifiers) ? tokenModifiers.map(String) : [],
  };
}

// ------------------------------------------------------------------- decoding

/** One token, at an absolute position, with its meaning resolved. */
export type SemanticToken = {
  /** Zero-based, as the protocol counts. */
  line: number;
  /** Zero-based character offset within the line. */
  char: number;
  length: number;
  /** The legend's name for this token's type, e.g. `"parameter"`. Empty when
   *  the server sent an index its own legend does not cover. */
  type: string;
  /** Legend names of every set modifier bit, in legend order. */
  modifiers: string[];
};

/** A guard against a pathological file rather than a real limit: 100k tokens is
 *  a document nobody is reading, and building that many decorations is a frozen
 *  window rather than a slow one. */
export const MAX_TOKENS = 100_000;

/**
 * Turn `textDocument/semanticTokens/full`'s `data` array into absolute tokens.
 *
 * The encoding is five integers per token and every one of them is relative:
 *
 *   `deltaLine`  lines since the previous token's line;
 *   `deltaStart` characters since the previous token's start **when
 *                `deltaLine` is 0**, and an absolute column otherwise;
 *   `length`     in UTF-16 code units, which is what the caller's document
 *                counts in too;
 *   `type`       an index into `legend.types`;
 *   `modifiers`  a bitset over `legend.modifiers`.
 *
 * The `deltaStart` rule is the whole trap: treating it as always-relative walks
 * every token after the first line break further and further right, and the
 * result still looks like plausible highlighting.
 *
 * Anything that does not parse is dropped rather than thrown on. A response is
 * decoration, and half a file's worth of correct colours beats none.
 */
export function decodeSemanticTokens(data: unknown, legend: SemanticLegend): SemanticToken[] {
  if (!Array.isArray(data)) return [];
  const out: SemanticToken[] = [];
  let line = 0;
  let char = 0;
  // Floor at the last whole token: a truncated tail would otherwise be read as
  // a token whose missing fields are `undefined`.
  const end = Math.floor(data.length / 5) * 5;
  for (let i = 0; i < end && out.length < MAX_TOKENS; i += 5) {
    // Indexed rather than sliced: a large file is tens of thousands of tokens,
    // and a `slice().map()` per token is two throwaway arrays each.
    const deltaLine = Number(data[i]);
    const deltaStart = Number(data[i + 1]);
    const length = Number(data[i + 2]);
    const type = Number(data[i + 3]);
    const modifiers = Number(data[i + 4]);
    if (!Number.isFinite(deltaLine) || !Number.isFinite(deltaStart)) continue;
    if (!Number.isFinite(length) || !Number.isFinite(type) || !Number.isFinite(modifiers)) continue;
    line += deltaLine;
    char = deltaLine === 0 ? char + deltaStart : deltaStart;
    if (length <= 0) continue;
    out.push({
      line,
      char,
      length,
      type: legend.types[type] ?? "",
      modifiers: modifiersOf(modifiers, legend),
    });
  }
  return out;
}

function modifiersOf(bits: number, legend: SemanticLegend): string[] {
  if (!bits) return [];
  const out: string[] = [];
  for (let i = 0; i < legend.modifiers.length; i += 1) {
    // Bit 31 and above are not addressable with `1 << i` in JS's signed 32-bit
    // bitwise ops; no legend is that long, but the arithmetic form costs
    // nothing and does not silently sign-flip if one ever is.
    if (Math.floor(bits / 2 ** i) % 2 === 1) out.push(legend.modifiers[i]);
  }
  return out;
}

// -------------------------------------------------------------------- styling

/** Which `--syntax-*` role a token type paints with.
 *
 *  Every value here is a role the theme already defines and the grammar already
 *  uses, so semantic colouring never introduces a colour: it moves *existing*
 *  colours onto the runs of text that actually deserve them. A parameter and a
 *  same-named property become distinguishable because the server can tell them
 *  apart, not because either one got a new hue. */
const TYPE_ROLE: Record<string, string> = {
  namespace: "namespace",
  type: "type",
  class: "class",
  enum: "type",
  interface: "type",
  struct: "class",
  typeParameter: "type",
  parameter: "parameter",
  variable: "variable",
  property: "property",
  enumMember: "constant",
  event: "property",
  function: "function",
  method: "method",
  macro: "function",
  keyword: "keyword",
  modifier: "keyword",
  comment: "comment",
  string: "string",
  number: "number",
  regexp: "regexp",
  operator: "operator",
  decorator: "function",
};

/** The `--syntax-*` roles semantic tokens can paint with, for the stylesheet
 *  that has to declare a rule per role. Deduplicated and sorted so the
 *  generated CSS is stable. */
export const SEMANTIC_ROLES: string[] = [...new Set(Object.values(TYPE_ROLE))].sort();

/** The one modifier that changes how a token renders. Struck through rather
 *  than recoloured, so it composes with whatever the type already painted:
 *  a deprecated method should still read as a method. */
export const DEPRECATED = "deprecated";

/** CSS classes for one token, or an empty list when nothing here has an opinion
 *  about it. Empty is the common and correct case for a server's own extension
 *  types, and it leaves the grammar's colour in place. */
export function tokenClasses(token: SemanticToken): string[] {
  const out: string[] = [];
  const role = TYPE_ROLE[token.type];
  if (role) out.push(`cm-sem-${role}`);
  if (token.modifiers.includes(DEPRECATED)) out.push("cm-sem-deprecated");
  return out;
}
