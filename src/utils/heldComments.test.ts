import { flush } from "solid-js";
import { describe, it, expect, afterEach } from "vite-plus/test";
import { clearHeld, dropHeld, heldFor, holdComment } from "./heldComments";

const A = "/work/repo-a";
const B = "topic:t1";
const comment = (text: string) => ({ path: `${A}/x.ts`, startLine: 1, endLine: 2, text });

describe("heldComments", () => {
  afterEach(() => {
    clearHeld(A);
    clearHeld(B);
  });

  it("collects comments in the order they were held", () => {
    holdComment(A, comment("one"));
    holdComment(A, comment("two"));
    flush();
    expect(heldFor(A).map((c) => c.text)).toEqual(["one", "two"]);
  });

  it("removes one entry and keeps the rest", () => {
    const first = holdComment(A, comment("one"));
    holdComment(A, comment("two"));
    dropHeld(A, [first.id]);
    flush();
    expect(heldFor(A).map((c) => c.text)).toEqual(["two"]);
  });

  it("clears a list", () => {
    holdComment(A, comment("one"));
    clearHeld(A);
    flush();
    expect(heldFor(A)).toEqual([]);
  });

  it("keeps two workspaces apart", () => {
    holdComment(A, comment("a"));
    holdComment(B, comment("b"));
    clearHeld(A);
    flush();
    expect(heldFor(A)).toEqual([]);
    expect(heldFor(B).map((c) => c.text)).toEqual(["b"]);
  });
});
