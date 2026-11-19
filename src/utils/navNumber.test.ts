import { describe, it, expect } from "vite-plus/test";
import { issueId, numberHit, numberQuery, ticketLabel } from "./navNumber";
import { parseQuery } from "./omniboxModes";
import { originRepo } from "./prUrl";

describe("a typed number", () => {
  it("reads every spelling of an issue or pull request", () => {
    expect(numberQuery("92")).toEqual({ repo: null, name: null, digits: "92" });
    expect(numberQuery("#92")).toEqual({ repo: null, name: null, digits: "92" });
    expect(numberQuery("tickets#92")).toEqual({ repo: null, name: "tickets", digits: "92" });
    expect(numberQuery("GetTori/Tickets#92")).toEqual({ repo: "gettori/tickets", name: null, digits: "92" });
    expect(numberQuery("https://github.com/gettori/tickets/issues/92")).toEqual({
      repo: "gettori/tickets",
      name: null,
      digits: "92",
    });
    expect(numberQuery("https://github.com/gettori/tori/pull/214/")).toMatchObject({
      repo: "gettori/tori",
      digits: "214",
    });
    expect(numberQuery("https://gitlab.com/group/sub/app/-/merge_requests/5")).toMatchObject({
      repo: "group/sub/app",
      digits: "5",
    });
  });

  it("is not a word with other text in it", () => {
    for (const word of ["side", "#", "92a", "fix-92", "tickets#", "https://github.com/gettori/tori"]) {
      expect(numberQuery(word)).toBeNull();
    }
  });

  it("stays in the all home as #92, and is a symbol search from files", () => {
    expect(parseQuery("#92", "all")).toEqual({ mode: "all", term: "#92" });
    expect(parseQuery("#92 side", "all").mode).toBe("all");
    expect(parseQuery("#Panel", "all").mode).toBe("workspace");
    expect(parseQuery("#92", "file").mode).toBe("workspace");
  });
});

describe("a stored issue key", () => {
  const origin = originRepo("git@github.com:GetTori/tickets.git");

  it("names one issue, bare in its own project and qualified elsewhere", () => {
    const own = issueId({ key: "92", url: "https://github.com/gettori/tickets/issues/92" }, origin);
    const elsewhere = issueId(
      { key: "gettori/tickets#92", url: "https://github.com/gettori/tickets/issues/92" },
      originRepo("https://github.com/gettori/tori.git"),
    );
    expect(own).toEqual({ repo: "gettori/tickets", number: 92 });
    expect(elsewhere).toEqual(own);
  });

  it("takes the repo from its URL when the origin is not known", () => {
    expect(issueId({ key: "92", url: "https://github.com/gettori/tickets/issues/92" }, null)).toEqual({
      repo: "gettori/tickets",
      number: 92,
    });
    expect(issueId({ key: "ENG-12", url: "https://linear.app/x/issue/ENG-12" }, origin)).toBeNull();
  });

  it("reads #N in its own project and name#N in another", () => {
    expect(ticketLabel({ key: "92", display: "#92" })).toBe("#92");
    expect(ticketLabel({ key: "gettori/tickets#92", display: "gettori/tickets#92" })).toBe("tickets#92");
    expect(ticketLabel({ key: "ENG-12", display: "ENG-12" })).toBe("ENG-12");
  });

  it("matches a typed repo, a typed name, or any repo for a bare number", () => {
    const id = { repo: "gettori/tickets", number: 92 };
    expect(numberHit(numberQuery("92")!, id)).toEqual({ exact: true, digitsAt: 0 });
    expect(numberHit(numberQuery("tickets#92")!, id)).toEqual({ exact: true, digitsAt: 0 });
    expect(numberHit(numberQuery("gettori/tickets#92")!, id)).toEqual({ exact: true, digitsAt: 0 });
    expect(numberHit(numberQuery("tori#92")!, id)).toBeNull();
    expect(numberHit(numberQuery("gettori/tori#92")!, id)).toBeNull();
  });

  it("matches digits as the whole number or a run inside it, never scattered", () => {
    const id = { repo: "gettori/tori", number: 1924 };
    expect(numberHit(numberQuery("92")!, id)).toEqual({ exact: false, digitsAt: 1 });
    expect(numberHit(numberQuery("14")!, id)).toBeNull();
  });
});
