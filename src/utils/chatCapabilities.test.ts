import { describe, it, expect } from "vitest";
import {
  chatPlugins,
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  steerCostLabel,
  stringList,
  NO_CHAT_TIER,
  type ChatTier,
} from "./chatCapabilities";

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

// The tier's whole job is to stop a surface promising what only Claude was
// measured doing, so these test the *values*, not the presence of the keys.
describe("the chat tier", () => {
  it("reports the PTY-only tier for an agent with no chat transport", () => {
    // Not "unknown" and not a degraded Claude: a PTY-only adapter ships no chat
    // transport at all, so every value is a plain no.
    expect(chatTier(null)).toEqual(NO_CHAT_TIER);
    expect(chatTier(undefined)).toEqual(NO_CHAT_TIER);
    expect(publishedCapabilities(NO_CHAT_TIER)).toEqual([]);
  });

  it("publishes what claude actually shipped, taken from the phases that measured it", () => {
    const tier = chatTier("claude_stream_json");
    expect(tier.rewind).toBe("fork");
    expect(tier.steer).toBe("consumed-before-next-tool");
    expect(tier.hooks).toBe(true);
  });

  it("never publishes a bare feature name, only the qualified value", () => {
    const filesOnly: ChatTier = { rewind: "files-only", steer: "none", steerCost: null, hooks: false };
    expect(publishedCapabilities(filesOnly)).toEqual([
      { key: "rewind", value: "files-only", label: "rewind: files-only" },
    ]);

    const buffered: ChatTier = {
      rewind: "none",
      steer: "buffered-to-turn-end",
      steerCost: { minMs: 1, maxMs: 2, trials: 1, measuredAgainst: "x" },
      hooks: false,
    };
    expect(publishedCapabilities(buffered)).toEqual([
      { key: "steer", value: "buffered-to-turn-end", label: "steer: buffered-to-turn-end" },
    ]);

    // The failure this exists to prevent: a label a reader could skim as the
    // unqualified capability.
    for (const cap of [...publishedCapabilities(filesOnly), ...publishedCapabilities(buffered)]) {
      expect(cap.label).not.toBe("rewind");
      expect(cap.label).not.toBe("steer");
      expect(cap.label).toBe(`${cap.key}: ${cap.value}`);
    }
  });

  it("omits a feature that did not ship rather than publishing it as none", () => {
    // A listing is a promise; an entry reading "rewind: none" invites reading
    // the key and skipping the value.
    expect(
      publishedCapabilities({ rewind: "none", steer: "none", steerCost: null, hooks: true }).map((c) => c.label),
    ).toEqual(["hooks: pretooluse"]);
  });

  it("quotes the measured steer cost rather than a rounder one", () => {
    const tier = chatTier("claude_stream_json");
    // Phase 2's spike 5: 1468ms and 5365ms were the fastest and slowest of the
    // three valid trials.
    expect(steerCostLabel(tier)).toBe("1.5-5.4s");
    const detail = steerCostDetail(tier);
    expect(detail).toContain("1.5-5.4s");
    // Provenance, so the figure ages honestly rather than reading as a promise.
    expect(detail).toContain("3 trials");
    expect(detail).toContain("claude 2.1.220");
    expect(detail).toContain("rather than guaranteed");
  });

  it("has no cost to quote where there is no steer", () => {
    expect(steerCostLabel(NO_CHAT_TIER)).toBeNull();
    expect(steerCostDetail(NO_CHAT_TIER)).toBeNull();
  });
});
