import { describe, it, expect, beforeEach } from "vitest";
import { SOURCE_KINDS } from "./events";
import {
  offersAnySourceAction,
  offersSourceAction,
  publishSourceActionKinds,
  sourceActionKinds,
} from "./sourceActions";

// Three states, and the whole point of the module is keeping them apart:
// nobody has said (no file, or its server has not answered), the server
// answered without enumerating, and the server enumerated.

beforeEach(() => publishSourceActionKinds(null));

describe("before anything has answered", () => {
  it("offers nothing, so the palette lists nothing", () => {
    expect(sourceActionKinds()).toBeNull();
    expect(offersAnySourceAction()).toBe(false);
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(false);
  });
});

describe("a server that enumerated its kinds", () => {
  it("offers the ones it named", () => {
    publishSourceActionKinds([SOURCE_KINDS.organizeImports, "quickfix"]);
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(true);
    expect(offersAnySourceAction()).toBe(true);
  });

  it("does not offer one it did not name", () => {
    publishSourceActionKinds([SOURCE_KINDS.organizeImports]);
    expect(offersSourceAction(SOURCE_KINDS.removeUnused)).toBe(false);
  });

  it("reads a parent kind as covering everything beneath it", () => {
    // The spec's kinds are hierarchical and dotted, so a server advertising
    // `source` has answered for every `source.*`.
    publishSourceActionKinds(["source"]);
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(true);
    expect(offersSourceAction(SOURCE_KINDS.sortImports)).toBe(true);
  });

  it("hides every command when it named only kinds that are not source ones", () => {
    publishSourceActionKinds(["quickfix", "refactor.extract"]);
    expect(offersAnySourceAction()).toBe(false);
  });
});

describe("a server that answered without enumerating", () => {
  it("is taken at its word rather than assumed to have none", () => {
    // `codeActionKinds` is optional in the spec. Omitting it says "I have not
    // told you", not "I have none", and refusing there would hide
    // organize-imports against a conformant server.
    publishSourceActionKinds([]);
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(true);
    expect(offersAnySourceAction()).toBe(true);
  });
});

describe("publishing", () => {
  it("keeps the same answer stable, so nothing rebuilds for nothing", () => {
    publishSourceActionKinds([SOURCE_KINDS.organizeImports]);
    const first = sourceActionKinds();
    publishSourceActionKinds([SOURCE_KINDS.organizeImports]);
    expect(sourceActionKinds(), "the same list is not a new one").toBe(first);
  });

  it("takes a new answer", () => {
    publishSourceActionKinds([SOURCE_KINDS.organizeImports]);
    publishSourceActionKinds([SOURCE_KINDS.removeUnused]);
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(false);
    expect(offersSourceAction(SOURCE_KINDS.removeUnused)).toBe(true);
  });

  it("copies what it is given, so a caller's array cannot change the answer later", () => {
    const mutable = [SOURCE_KINDS.organizeImports];
    publishSourceActionKinds(mutable);
    mutable.length = 0;
    expect(offersSourceAction(SOURCE_KINDS.organizeImports)).toBe(true);
  });
});
