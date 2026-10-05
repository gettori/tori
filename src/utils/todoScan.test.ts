import { describe, it, expect } from "vite-plus/test";
import {
  filterByTags,
  groupTodos,
  tagCounts,
  todoItems,
  todoQuery,
  todoSummary,
  todoTags,
  type TodoMatch,
} from "./todoScan";

// The setting is hand-typed and the hits come from a backend that already
// decided what matched. So what is pinned here is the boundary between those
// two: what a typed tag list means, and that a row's label comes from the hit
// rather than from asking the question a second time in JavaScript.

const hit = (path: string, line: number, text: string, span: [number, number]): TodoMatch => ({
  path,
  line,
  text,
  submatches: [span],
});

describe("reading the tag setting", () => {
  it("splits on commas and forgives the spacing", () => {
    expect(todoTags("TODO, FIXME ,HACK")).toEqual(["TODO", "FIXME", "HACK"]);
  });

  it("drops the empties a trailing or doubled comma leaves", () => {
    // An empty tag would become an empty alternation branch, which matches at
    // every position: the panel would list every line in the project.
    expect(todoTags("TODO,,FIXME,")).toEqual(["TODO", "FIXME"]);
    expect(todoTags("")).toEqual([]);
    expect(todoTags("  ,  ")).toEqual([]);
  });

  it("keeps one of a repeated tag", () => {
    expect(todoTags("TODO,TODO")).toEqual(["TODO"]);
  });
});

describe("the query it searches with", () => {
  it("asks for every tag at once", () => {
    // One search, not one per tag: the backend caps its results, and N searches
    // would each get their own cap, so a repo full of TODOs could hide every
    // FIXME behind them.
    expect(todoQuery(["TODO", "FIXME"])).toBe("TODO|FIXME");
  });

  it("matches a tag with punctuation in it as the text it is", () => {
    // A tag is a label, not a pattern. Left unescaped, `TODO(x)` would search
    // for a capture group and quietly match a bare `TODO`.
    expect(todoQuery(["TODO(x)"])).toBe("TODO\\(x\\)");
    expect(todoQuery(["C++"])).toBe("C\\+\\+");
  });

  it("leaves a tag that starts with punctuation alone", () => {
    // The reason there are no word boundaries: `\b@todo` can never match,
    // because there is no word character before the `@` to bound against.
    expect(todoQuery(["@todo"])).toBe("@todo");
  });
});

describe("turning hits into rows", () => {
  it("labels each row with the tag the backend actually matched", () => {
    const rows = todoItems([hit("src/a.ts", 12, "  // TODO: wire this up", [5, 9])]);
    expect(rows).toEqual([
      { path: "src/a.ts", line: 12, tag: "TODO", text: "// TODO: wire this up" },
    ]);
  });

  it("trims the line, because a TODO sits behind whatever indents it", () => {
    const rows = todoItems([hit("a.ts", 1, "\t\t// FIXME later", [5, 10])]);
    expect(rows[0].text).toBe("// FIXME later");
    expect(rows[0].tag).toBe("FIXME");
  });

  it("skips a hit with no span rather than inventing a tag for it", () => {
    expect(todoItems([{ path: "a.ts", line: 1, text: "TODO", submatches: [] }])).toEqual([]);
  });

  it("groups by file, in the order the files were reported", () => {
    const rows = todoItems([
      hit("b.ts", 1, "TODO one", [0, 4]),
      hit("a.ts", 2, "TODO two", [0, 4]),
      hit("b.ts", 9, "TODO three", [0, 4]),
    ]);
    expect(groupTodos(rows).map((g) => [g.path, g.items.length])).toEqual([
      ["b.ts", 2],
      ["a.ts", 1],
    ]);
  });
});

describe("the tag chips", () => {
  const rows = todoItems([
    hit("a.ts", 1, "TODO one", [0, 4]),
    hit("a.ts", 2, "TODO two", [0, 4]),
    hit("a.ts", 3, "FIXME it", [0, 5]),
  ]);

  it("counts every configured tag, zero included", () => {
    // A chip that appears and vanishes as files are edited under it is a
    // control that moves while you are reaching for it.
    expect(tagCounts(rows, ["TODO", "FIXME", "HACK"])).toEqual({ TODO: 2, FIXME: 1, HACK: 0 });
  });

  it("shows everything when nothing is selected", () => {
    expect(filterByTags(rows, new Set()).length).toBe(3);
  });

  it("shows the union of the selected tags", () => {
    expect(filterByTags(rows, new Set(["FIXME"])).map((i) => i.line)).toEqual([3]);
    expect(filterByTags(rows, new Set(["TODO", "FIXME"])).length).toBe(3);
  });
});

describe("what it says above the list", () => {
  const one = todoItems([hit("a.ts", 1, "TODO x", [0, 4])]);

  it("counts items and files, singular where it should be", () => {
    expect(todoSummary(one, 1, false)).toBe("1 item in 1 file");
    expect(todoSummary([...one, ...one], 2, false)).toBe("2 items in 2 files");
  });

  it("names the cap when the backend truncated, not the count already on screen", () => {
    // The thing the user cannot see is that the project holds more than this.
    // Repeating a number they are looking at tells them nothing, and the cap is
    // also the one figure a chip selection does not change.
    expect(todoSummary(one, 1, true, 500)).toBe(
      "1 item in 1 file (capped at 500, narrow the tags to see the rest)",
    );
  });
});
