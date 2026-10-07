import { describe, it, expect } from "vite-plus/test";
import type { PullRequest } from "./forgeTypes";
import { prHits, prRef } from "./prMention";

function pr(number: number, title = `pr ${number}`): PullRequest {
  return {
    number,
    title,
    body: null,
    state: "open",
    isDraft: false,
    author: "a",
    createdAt: "2026-10-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    comments: 0,
    headRef: `feat/${number}`,
    baseRef: "main",
    headSha: "abc",
    headRepoIsOrigin: true,
    url: `https://github.com/o/r/pull/${number}`,
    mergeableState: "clean",
  };
}

const numbers = (hits: ReturnType<typeof prHits>) =>
  hits.map((h) => (h.kind === "pr" ? h.pr.number : `resolve ${h.number}`));

describe("prHits", () => {
  const list = [pr(12), pr(120, "Fix login"), pr(121, "Docs")];

  it("lists newest first for a bare #", () => {
    expect(numbers(prHits(list, ""))).toEqual([121, 120, 12]);
  });

  it("leads with the exact number, then the ones it prefixes", () => {
    expect(numbers(prHits(list, "12"))).toEqual([12, 121, 120]);
  });

  // So Enter on "fixes #4" sends the sentence rather than picking something.
  it("leads with the resolve row when the list does not hold the number", () => {
    expect(numbers(prHits(list, "4"))).toEqual(["resolve 4"]);
    expect(numbers(prHits([pr(40)], "4"))).toEqual(["resolve 4", 40]);
  });

  it("matches words against titles", () => {
    expect(numbers(prHits(list, "login"))).toEqual([120]);
  });
});

describe("prRef", () => {
  it("snapshots what the note needs", () => {
    expect(prRef(pr(7, "Seven"))).toEqual({
      type: "ref",
      label: "[PR 7]",
      target: {
        kind: "pr",
        number: 7,
        title: "Seven",
        url: "https://github.com/o/r/pull/7",
        state: "open",
        draft: false,
        head: "feat/7",
        base: "main",
      },
    });
  });
});
