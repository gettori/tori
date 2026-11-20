import { describe, it, expect } from "vite-plus/test";
import { issueId, numberHit, numberQuery, pathQuery, portQuery, ticketLabel } from "./navNumber";
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

describe("a pasted path or port", () => {
  const TORI = "/Users/you/Projects/tori";
  const WT = `${TORI}-wt/fix-92`;
  const folders = [TORI, WT, `${TORI}/vendor/kit`];

  it("opens a path in the deepest folder holding it, at the line a compiler printed", () => {
    expect(pathQuery(`  ${WT}/src/App.tsx:12:5 `, folders)).toEqual({
      folder: WT,
      path: `${WT}/src/App.tsx`,
      rel: "src/App.tsx",
      line: 12,
    });
    expect(pathQuery(`${TORI}/vendor/kit/index.ts`, folders)).toMatchObject({ folder: `${TORI}/vendor/kit` });
    expect(pathQuery(`${TORI}/`, folders)).toMatchObject({ folder: TORI, rel: "" });
    expect(pathQuery(`${TORI}/a:b.ts`, folders)).toMatchObject({ rel: "a:b.ts", line: undefined });
  });

  it("leaves a path no folder holds, and a files query, to the prefix router", () => {
    expect(pathQuery(`${TORI}-web/src/main.ts`, folders)).toBeNull();
    expect(pathQuery("/src/App.tsx", folders)).toBeNull();
    expect(pathQuery("src/App.tsx", folders)).toBeNull();
  });

  it("reads localhost and its loopback spellings, with a scheme or a path", () => {
    expect(portQuery("localhost:5173")).toBe(5173);
    expect(portQuery("http://localhost:5173/settings")).toBe(5173);
    expect(portQuery("127.0.0.1:3000")).toBe(3000);
    expect(portQuery("HTTPS://[::1]:8080")).toBe(8080);
    for (const raw of ["localhost", "localhost:0", "localhost:70000", "example.com:80", "localhost:5173 now"]) {
      expect(portQuery(raw)).toBeNull();
    }
  });
});
