import { describe, it, expect } from "vitest";
import {
  decodeSemanticTokens,
  legendFrom,
  semanticTokensClientCapabilities,
  tokenClasses,
  SEMANTIC_ROLES,
  MAX_TOKENS,
  type SemanticLegend,
} from "./semanticTokens";

// The wire format is five relative integers per token indexed against a legend
// the server declared once. Every test here is about a way of reading that
// wrong which still produces plausible-looking output: colours a few characters
// to the right, or the right colours on the wrong words. A decoder bug does not
// throw, it just lies.

/** The legend `typescript-language-server` actually declares. Order matters:
 *  every index in every response is against this list. */
const TS_LEGEND: SemanticLegend = {
  types: [
    "class",
    "enum",
    "interface",
    "namespace",
    "typeParameter",
    "type",
    "parameter",
    "variable",
    "enumMember",
    "property",
    "function",
    "method",
  ],
  modifiers: ["declaration", "static", "async", "readonly", "defaultLibrary", "local"],
};

const FUNCTION = 10;
const PARAMETER = 6;
const PROPERTY = 9;
const DECLARATION = 1; // bit 0

describe("legendFrom", () => {
  it("reads a real server's provider", () => {
    const provider = {
      legend: { tokenTypes: TS_LEGEND.types, tokenModifiers: TS_LEGEND.modifiers },
      full: true,
      range: true,
    };
    expect(legendFrom(provider)).toEqual(TS_LEGEND);
  });

  it("is null for a server that advertises no provider", () => {
    // The state every server without semantic tokens is in, and the state every
    // server is in before `initialize` is answered. Both degrade to lexical
    // highlighting rather than throwing, which is what the file had anyway.
    expect(legendFrom(undefined)).toBeNull();
    expect(legendFrom(null)).toBeNull();
    expect(legendFrom(true)).toBeNull();
  });

  it("is null when the provider carries no usable legend", () => {
    // Without a legend the numbers in every response are uninterpretable, which
    // is worse than not asking: an index read against a guessed list colours the
    // file confidently and wrongly.
    expect(legendFrom({ full: true })).toBeNull();
    expect(legendFrom({ legend: {} })).toBeNull();
    expect(legendFrom({ legend: { tokenTypes: "class" } })).toBeNull();
  });

  it("accepts a legend that declares no modifiers", () => {
    const legend = legendFrom({ legend: { tokenTypes: ["variable"] } });
    expect(legend).toEqual({ types: ["variable"], modifiers: [] });
  });
});

describe("decodeSemanticTokens", () => {
  it("turns the deltas back into absolute positions", () => {
    //   function greet(name: string) {
    //     return name;
    //   }
    const data = [
      0, 9, 5, FUNCTION, DECLARATION,
      0, 6, 4, PARAMETER, DECLARATION,
      1, 9, 4, PARAMETER, 0,
    ];
    expect(decodeSemanticTokens(data, TS_LEGEND)).toEqual([
      { line: 0, char: 9, length: 5, type: "function", modifiers: ["declaration"] },
      { line: 0, char: 15, length: 4, type: "parameter", modifiers: ["declaration"] },
      { line: 1, char: 9, length: 4, type: "parameter", modifiers: [] },
    ]);
  });

  it("restarts the column at a line break instead of carrying it", () => {
    // The trap the whole encoding turns on: `deltaStart` is relative only while
    // `deltaLine` is 0, and absolute otherwise. Reading it as always-relative
    // walks every token after the first newline further and further right, and
    // the file still looks highlighted.
    const data = [5, 2, 3, PARAMETER, 0, 1, 4, 3, PARAMETER, 0];
    const [, second] = decodeSemanticTokens(data, TS_LEGEND);
    expect(second).toEqual({ line: 6, char: 4, length: 3, type: "parameter", modifiers: [] });
  });

  it("accumulates line deltas across many tokens", () => {
    const data = [10, 0, 1, PARAMETER, 0, 3, 0, 1, PARAMETER, 0, 7, 0, 1, PARAMETER, 0];
    expect(decodeSemanticTokens(data, TS_LEGEND).map((t) => t.line)).toEqual([10, 13, 20]);
  });

  it("reads the modifier bitset as bits, not as an index", () => {
    // `declaration | readonly` is 9, which as an index would be out of range and
    // as a single bit would be nothing at all.
    const data = [0, 0, 4, PROPERTY, 0b1001];
    expect(decodeSemanticTokens(data, TS_LEGEND)[0].modifiers).toEqual(["declaration", "readonly"]);
  });

  it("keeps a token whose type the legend does not cover", () => {
    // A server may send an index past its own legend, and dropping the token
    // would leave a hole where the grammar's colour also got overridden. It
    // keeps its position and simply has no opinion about how it looks.
    const data = [0, 0, 4, 99, 0];
    expect(decodeSemanticTokens(data, TS_LEGEND)[0]).toMatchObject({ type: "", length: 4 });
  });

  it("ignores a trailing partial token", () => {
    // Five fields per token; a truncated response would otherwise be read as a
    // token whose missing fields are `undefined`, which becomes NaN positions.
    const data = [0, 0, 4, PARAMETER, 0, 0, 5, 3];
    expect(decodeSemanticTokens(data, TS_LEGEND)).toHaveLength(1);
  });

  it("drops a zero-length token rather than emitting an empty range", () => {
    const data = [0, 0, 0, PARAMETER, 0, 0, 2, 3, PARAMETER, 0];
    expect(decodeSemanticTokens(data, TS_LEGEND)).toHaveLength(1);
  });

  it("answers empty for anything that is not an array", () => {
    // A server that declined, or a response shape that moved.
    expect(decodeSemanticTokens(null, TS_LEGEND)).toEqual([]);
    expect(decodeSemanticTokens(undefined, TS_LEGEND)).toEqual([]);
    expect(decodeSemanticTokens({ data: [] }, TS_LEGEND)).toEqual([]);
  });

  it("stops at the cap rather than building decorations nobody can read", () => {
    const data: number[] = [];
    for (let i = 0; i < MAX_TOKENS + 50; i += 1) data.push(1, 0, 2, PARAMETER, 0);
    expect(decodeSemanticTokens(data, TS_LEGEND)).toHaveLength(MAX_TOKENS);
  });
});

describe("tokenClasses", () => {
  const token = (type: string, modifiers: string[] = []) => ({
    line: 0,
    char: 0,
    length: 1,
    type,
    modifiers,
  });

  it("tells a parameter apart from a property", () => {
    // The whole point of the feature, and the one thing lexical highlighting
    // cannot do: `foo` in `f(foo)` and `foo` in `{ foo: 1 }` are the same three
    // characters to a grammar.
    expect(tokenClasses(token("parameter"))).toEqual(["cm-sem-parameter"]);
    expect(tokenClasses(token("property"))).toEqual(["cm-sem-property"]);
  });

  it("has nothing to say about a type it does not know", () => {
    // rust-analyzer ships a dozen of its own. Silence leaves the grammar's
    // colour in place, which is the right answer for a type Tori has no role for.
    expect(tokenClasses(token("selfKeyword"))).toEqual([]);
    expect(tokenClasses(token(""))).toEqual([]);
  });

  it("marks a deprecated symbol without taking its colour away", () => {
    // Struck through, not recoloured: a deprecated method should still read as
    // a method.
    expect(tokenClasses(token("method", ["deprecated"]))).toEqual([
      "cm-sem-method",
      "cm-sem-deprecated",
    ]);
  });

  it("ignores modifiers nothing renders differently", () => {
    expect(tokenClasses(token("variable", ["readonly", "static"]))).toEqual(["cm-sem-variable"]);
  });

  it("publishes every role it can paint with, deduplicated", () => {
    // The list the stylesheet generates a rule per, and the list check 7 of
    // `scripts/check-tokens.mjs` proves resolves to a real `--syntax-*` token.
    // Membership rather than an exact list: adding a token type is a normal
    // change, and this should not have to be edited to allow one. What the
    // colours *are* is check 7's job, and it reads the same export.
    expect(SEMANTIC_ROLES).toContain("parameter");
    expect(SEMANTIC_ROLES).toContain("property");
    expect(new Set(SEMANTIC_ROLES).size).toBe(SEMANTIC_ROLES.length);
    expect([...SEMANTIC_ROLES].sort()).toEqual(SEMANTIC_ROLES);
  });
});

describe("the capability block", () => {
  const caps = semanticTokensClientCapabilities.clientCapabilities;

  it("asks for the full-document request in the only format the decoder reads", () => {
    const semantic = caps.textDocument.semanticTokens;
    expect(semantic.requests.full).toBe(true);
    expect(semantic.formats).toEqual(["relative"]);
    expect(semantic.tokenTypes).toContain("parameter");
    expect(semantic.tokenModifiers).toContain("deprecated");
  });

  it("says it augments the grammar rather than replacing it", () => {
    // Tori keeps lexical highlighting underneath, so a server should not be
    // asked to tokenise the punctuation and comments already coloured.
    expect(caps.textDocument.semanticTokens.augmentsSyntaxTokens).toBe(true);
  });

  it("does not ask for anything the decoder cannot read", () => {
    // Multiline and overlapping tokens are both declined, and the decoration
    // builder clamps to the line on the strength of that.
    expect(caps.textDocument.semanticTokens.multilineTokenSupport).toBe(false);
    expect(caps.textDocument.semanticTokens.overlappingTokenSupport).toBe(false);
    expect(caps.textDocument.semanticTokens.dynamicRegistration).toBe(false);
  });

  it("invites the one server-initiated request Tori answers", () => {
    // Against the rule the rest of the capability surface follows, and
    // deliberately: without it a server never says its answers went stale, and
    // editing a type in one file leaves every other file's colours wrong until
    // it is reopened. `lspClient.ts` answers it in the transport.
    expect(caps.workspace.semanticTokens.refreshSupport).toBe(true);
  });
});
