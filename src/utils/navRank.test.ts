import { describe, it, expect } from "vite-plus/test";
import { rank, type RankInput } from "./navRank";

type Row = { id: string; title: string; trail?: string; ticket?: string; command?: boolean };

const fields = (r: Row): RankInput => ({
  fields: [
    { slot: "title", text: r.title },
    ...(r.trail ? [{ slot: "trail", text: r.trail }] : []),
    ...(r.ticket ? [{ slot: "ticket", text: r.ticket, hidden: true }] : []),
  ],
  penalty: r.command,
});

const ids = (rows: Row[], q: string) => rank(rows, q, fields).map((r) => r.item.id);

describe("the navigator's ranker", () => {
  it("orders exact, then prefix, then word start, then subsequence", () => {
    const rows: Row[] = [
      { id: "subsequence", title: "s-plit-ide" },
      { id: "inside", title: "inside" },
      { id: "word start", title: "the-side-panel" },
      { id: "prefix", title: "sidebar" },
      { id: "exact", title: "Side" },
      { id: "none", title: "elsewhere" },
    ];
    expect(ids(rows, "side")).toEqual(["exact", "prefix", "word start", "inside", "subsequence"]);
  });

  it("counts a camel-case hump as a word start", () => {
    expect(rank([{ id: "a", title: "openSidePanel" }], "side", fields)[0].marks).toEqual({
      title: [{ start: 4, end: 8 }],
    });
  });

  it("needs every word somewhere, and marks each where it matched", () => {
    const rows: Row[] = [
      { id: "both", title: "side-panel", trail: "work / tori" },
      { id: "one", title: "side-quest", trail: "labs / probe" },
    ];
    const out = rank(rows, "tori side", fields);
    expect(out.map((r) => r.item.id)).toEqual(["both"]);
    expect(out[0].marks).toEqual({ title: [{ start: 0, end: 4 }], trail: [{ start: 7, end: 11 }] });
  });

  it("matches a subsequence in the title only", () => {
    expect(ids([{ id: "a", title: "zz", trail: "a-b-c-e" }], "ace")).toEqual([]);
    expect(ids([{ id: "a", title: "a-b-c-e" }], "ace")).toEqual(["a"]);
  });

  it("ranks a hidden match below a title match and says which slot it was", () => {
    const rows: Row[] = [
      { id: "hidden", title: "tickets-92", ticket: "Browser side panel" },
      { id: "title", title: "browser-tabs" },
    ];
    const out = rank(rows, "browser", fields);
    expect(out.map((r) => r.item.id)).toEqual(["title", "hidden"]);
    expect(out[1].marks).toEqual({ ticket: [{ start: 0, end: 7 }] });
  });

  it("gives a place the tie against a command", () => {
    const rows: Row[] = [
      { id: "command", title: "Sidebar", command: true },
      { id: "place", title: "sidebar" },
    ];
    expect(ids(rows, "sidebar")).toEqual(["place", "command"]);
  });

  it("keeps the given order between equal scores, and for an empty query", () => {
    const rows: Row[] = [
      { id: "b", title: "main" },
      { id: "a", title: "main" },
    ];
    expect(ids(rows, "main")).toEqual(["b", "a"]);
    expect(ids(rows, "  ")).toEqual(["b", "a"]);
  });
});
