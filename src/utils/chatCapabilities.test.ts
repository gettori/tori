import { describe, it, expect } from "vitest";
import { chatPlugins, stringList } from "./chatCapabilities";

describe("stringList", () => {
  it("reads the measured shape: a plain array of strings", () => {
    // claude 2.1.220's system/init reports skills and agents this way.
    expect(stringList({ skills: ["adversary", "grill-plan", "handoff"] }, "skills")).toEqual([
      "adversary",
      "grill-plan",
      "handoff",
    ]);
  });

  it("is empty for a missing key or a non-array", () => {
    expect(stringList(undefined, "skills")).toEqual([]);
    expect(stringList({}, "skills")).toEqual([]);
    expect(stringList({ skills: "adversary" }, "skills")).toEqual([]);
  });

  it("drops entries it cannot read rather than rendering them", () => {
    // A future CLI promoting these to objects must not put "[object Object]"
    // in front of the user.
    expect(stringList({ skills: ["ok", { name: "obj" }, null, 7, ""] }, "skills")).toEqual(["ok"]);
  });
});

describe("chatPlugins", () => {
  it("reads the measured object shape", () => {
    const got = chatPlugins({
      plugins: [
        {
          name: "context-mode",
          path: "/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.162",
          source: "context-mode@context-mode",
          version: "1.0.162",
        },
      ],
    });
    expect(got).toEqual([
      {
        name: "context-mode",
        version: "1.0.162",
        source: "context-mode@context-mode",
        path: "/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.162",
      },
    ]);
  });

  it("accepts a bare string, the shape skills and agents already use", () => {
    expect(chatPlugins({ plugins: ["plain"] })).toEqual([
      { name: "plain", version: null, source: null, path: null },
    ]);
  });

  it("drops an entry with no name, since it cannot be listed usefully", () => {
    expect(chatPlugins({ plugins: [{ version: "1" }, null, 3] })).toEqual([]);
  });

  it("leaves absent optional fields null rather than undefined", () => {
    // A `null` renders as "unknown"; an `undefined` would read as a bug.
    expect(chatPlugins({ plugins: [{ name: "p" }] })).toEqual([
      { name: "p", version: null, source: null, path: null },
    ]);
  });
});
