import { describe, it, expect } from "vite-plus/test";
import { rank, type RankInput, type RankNumber } from "./navRank";

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

type Numbered = { id: string; title: string; numbers: RankNumber[] };

const numbered = (r: Numbered): RankInput => ({ fields: [{ slot: "title", text: r.title }], numbers: r.numbers });
const TORI = "gettori/tori";
const TICKETS = "gettori/tickets";
const issue = (repo: string, number: number): RankNumber => ({
  kind: "issue",
  slot: "ticket",
  id: { repo, number },
  digitsAt: 1,
});
const pr = (repo: string, number: number): RankNumber => ({
  kind: "pr",
  slot: "pr",
  id: { repo, number },
  digitsAt: 1,
});

describe("the ranker's numbers", () => {
  it("puts the linked issue first, then the pull request, then a number in the branch name", () => {
    const rows: Numbered[] = [
      {
        id: "branch",
        title: "92-side",
        numbers: [{ kind: "branch", slot: "title", id: { repo: TORI, number: 92 }, digitsAt: 0 }],
      },
      { id: "pr", title: "fix-tabs", numbers: [pr(TORI, 92)] },
      { id: "issue", title: "side-panel", numbers: [issue(TICKETS, 92)] },
      { id: "within", title: "tabs", numbers: [issue(TICKETS, 1924)] },
    ];
    expect(rank(rows, "92", numbered).map((r) => r.item.id)).toEqual(["issue", "pr", "branch", "within"]);
  });

  it("marks the digits on the chip or in the branch name that matched", () => {
    const rows: Numbered[] = [
      { id: "chip", title: "side-panel", numbers: [issue(TICKETS, 1924)] },
      {
        id: "branch",
        title: "fix-92",
        numbers: [{ kind: "branch", slot: "title", id: { repo: TORI, number: 92 }, digitsAt: 4 }],
      },
    ];
    const out = rank(rows, "#92", numbered);
    expect(out.find((r) => r.item.id === "chip")?.marks).toEqual({ ticket: [{ start: 2, end: 4 }] });
    expect(out.find((r) => r.item.id === "branch")?.marks).toEqual({ title: [{ start: 4, end: 6 }] });
  });

  it("narrows two repos sharing a number to the one typed, and keeps both for a bare number", () => {
    const rows: Numbered[] = [
      { id: "tori", title: "a", numbers: [issue(TORI, 92)] },
      { id: "tickets", title: "b", numbers: [issue(TICKETS, 92)] },
    ];
    expect(rank(rows, "92", numbered).map((r) => r.item.id)).toEqual(["tori", "tickets"]);
    expect(rank(rows, "tickets#92", numbered).map((r) => r.item.id)).toEqual(["tickets"]);
    expect(rank(rows, "gettori/tori#92", numbered).map((r) => r.item.id)).toEqual(["tori"]);
  });

  it("finds a chat by an issue it mentioned, below every row that has the number on it", () => {
    const mention = (number: number, slot: string): RankNumber => ({
      kind: "mention",
      slot,
      id: { repo: TICKETS, number },
      digitsAt: 1,
    });
    const rows: Numbered[] = [
      { id: "chat", title: "Release notes", numbers: [mention(7, "mention:0"), mention(92, "mention:1")] },
      {
        id: "branch",
        title: "92-side",
        numbers: [{ kind: "branch", slot: "title", id: { repo: TORI, number: 92 }, digitsAt: 0 }],
      },
      { id: "quiet", title: "Standup", numbers: [mention(7, "mention:0")] },
    ];
    const out = rank(rows, "92", numbered);
    expect(out.map((r) => r.item.id)).toEqual(["branch", "chat"]);
    expect(out[1].marks).toEqual({ "mention:1": [{ start: 1, end: 3 }] });
  });

  it("never matches a number as a subsequence", () => {
    const rows: Numbered[] = [
      { id: "scattered", title: "9-1-2", numbers: [issue(TORI, 912)] },
      { id: "run", title: "release-92", numbers: [] },
    ];
    expect(rank(rows, "92", numbered).map((r) => r.item.id)).toEqual(["run"]);
  });
});
