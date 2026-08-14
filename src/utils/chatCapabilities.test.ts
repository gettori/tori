import { describe, it, expect } from "vitest";
import {
  chatPlugins,
  chatTier,
  publishedCapabilities,
  steerCostDetail,
  unavailableCapabilities,
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
    // These three were one `hooks: true` while they rode one mechanism. They no
    // longer do, and the split is the point: the harness asks, the hook does
    // nothing but capture, and the ceiling needs no hook at all. A fourth,
    // `swayRules`, went with the gate: there is no Sway-owned rule store left
    // for any harness to publish.
    expect(tier.approvals).toBe("in-protocol");
    expect(tier).not.toHaveProperty("swayRules");
    expect(tier.diffs).toBe("before-state");
    expect(tier.spendCeilings).toBe(true);
  });

  it("never publishes a bare feature name, only the qualified value", () => {
    const filesOnly: ChatTier = { ...NO_CHAT_TIER, rewind: "files-only" };
    expect(publishedCapabilities(filesOnly)).toEqual([
      { key: "rewind", value: "files-only", label: "rewind: files-only" },
    ]);

    const buffered: ChatTier = {
      ...NO_CHAT_TIER,
      steer: "buffered-to-turn-end",
      steerCost: { minMs: 1, maxMs: 2, trials: 1, measuredAgainst: "x" },
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
      publishedCapabilities({ ...NO_CHAT_TIER, approvals: "in-protocol" }).map((c) => c.label),
    ).toEqual(["approvals: in-protocol"]);
  });

  // The one that would have been hidden by the old single flag: a harness whose
  // permission question Sway renders, but which Sway cannot gate itself and
  // whose writes it cannot diff. Under `hooks: boolean` that had to be answered
  // yes or no for all four.
  it("publishes the four former hook features independently", () => {
    const partial: ChatTier = { ...NO_CHAT_TIER, approvals: "in-protocol", spendCeilings: true };
    expect(publishedCapabilities(partial).map((c) => c.label)).toEqual([
      "approvals: in-protocol",
      "budgets: turn-boundary",
    ]);
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

describe("every tier explains what it lacks", () => {
  // The compiler makes a new transport state its values; this makes it state its
  // *reasons*. Without it the honest half of the design - "omitted from the
  // promise list, explained somewhere else" - degrades to just omitted, and a
  // user meets a missing control with nothing to read.
  it("names a reason for every affordance it does not have", () => {
    for (const transport of ["claude_stream_json", "acp"] as const) {
      const tier = chatTier(transport);
      const published = new Set(publishedCapabilities(tier).map((c) => c.key));
      const explained = new Set(unavailableCapabilities(tier).map((g) => g.key));

      // Every gap in the tier's own values is explained...
      const expected = [
        ["rewind", tier.rewind === "none"],
        ["steer", tier.steer === "none"],
        ["approvals", tier.approvals === "none"],
        ["diffs", tier.diffs === "none"],
        ["budgets", !tier.spendCeilings],
      ] as const;
      for (const [key, missing] of expected) {
        if (missing) {
          expect(explained.has(key), `${transport} must explain why it has no ${key}`).toBe(true);
        }
      }

      // ...and nothing is both promised and explained away, which would be a
      // note left behind by a capability that has since shipped.
      for (const key of explained) {
        expect(published.has(key), `${transport}: ${key} is both published and missing`).toBe(false);
      }
      // A reason a user can act on, not a restatement of the key.
      for (const gap of unavailableCapabilities(tier)) {
        expect(gap.why.length, `${transport}.${gap.key}`).toBeGreaterThan(40);
      }
    }
  });

  it("says nothing five times over for an agent with no chat surface at all", () => {
    expect(unavailableCapabilities(NO_CHAT_TIER)).toEqual([]);
  });
});

describe("the ACP tier", () => {
  it("publishes what an ACP session earns and omits every affordance it lacks", () => {
    const tier = chatTier("acp");
    const keys = publishedCapabilities(tier).map((c) => c.key);

    // The one thing ACP earns outright: the agent asks, Sway renders.
    expect(tier.approvals).toBe("in-protocol");
    expect(publishedCapabilities(tier)).toContainEqual({
      key: "approvals",
      value: "in-protocol",
      label: "approvals: in-protocol",
    });

    // The two the plan names as unsupported and this build still lacks, absent
    // from the listing rather than published as `none`. An entry for something
    // absent invites reading the key and skipping the value.
    expect(tier.spendCeilings).toBe(false);
    expect(tier.rewind).toBe("none");
    expect(keys).not.toContain("budgets");
    expect(keys).not.toContain("rewind");
    // And Sway's own rule store, which only the Claude hook reads.
    expect(keys).not.toContain("rules");

    // **Diffs left that list in Phase 8.** The plan said ACP agents cannot
    // produce an exact before-state because it rides the Claude-only hook;
    // `codex-acp` sends one in the tool call. So it is published, and the value
    // carries the qualification rather than promising it for every agent.
    expect(tier.diffs).toBe("agent-supplied");
    expect(publishedCapabilities(tier)).toContainEqual({
      key: "diffs",
      value: "agent-supplied",
      label: "diffs: agent-supplied",
    });
  });

  it("never reports a budget as armed, because ACP reports no cost to measure", () => {
    // The load-bearing half of "budgets never report as armed for an ACP
    // session": `applyBudget` returns early on this flag, and a ceiling that
    // reads as armed while nothing can fire it is the one failure a spend limit
    // must not have. ACP's usage update carries context occupancy, not money.
    expect(chatTier("acp").spendCeilings).toBe(false);
  });

  it("offers no rewind timestamp, so revert is unavailable rather than failing when clicked", () => {
    // ChatView gates on `rewind === "fork"`. Both measured agents advertise
    // `sessionCapabilities.fork`, but Sway's fork is `fork_args` plus a tree
    // snapshot and the ACP transport implements no fork verb, so the honest
    // answer is that the control does not appear.
    expect(chatTier("acp").rewind).not.toBe("fork");
  });

  // Each with the reason a user can act on rather than the mechanism they
  // cannot. The plan named three; diffs left the list in Phase 8 when an agent
  // turned out to send them, so a gap for it here would explain an absence that
  // is not one.
  it("names revert and spend ceilings as unavailable, and says why", () => {
    const gaps = unavailableCapabilities(chatTier("acp"));
    const by = (key: string) => gaps.find((g) => g.key === key)?.why ?? "";

    expect(by("diffs")).toBe("");
    expect(by("rewind")).toContain("fork");
    // Not "it rides the hook", which stopped being true when the ceiling moved
    // to the turn boundary. The real reason is that ACP reports no cost.
    expect(by("budgets")).toContain("cost");
    expect(by("budgets")).not.toContain("hook");
    // And what the user still has instead, where there is something.
    expect(by("rewind")).toContain("Changes panel");
    // There is no `rules` gap to explain any more: no harness has a Sway-owned
    // rule store, so its absence is not a thing this transport lacks.
    expect(by("rules")).toBe("");
  });

  it("cannot steer, and quotes no cost for one", () => {
    const tier = chatTier("acp");
    expect(tier.steer).toBe("none");
    expect(tier.steerCost).toBeNull();
    expect(steerCostLabel(tier)).toBeNull();
  });

  // The point of a generic client: two agents behind one transport differ, and
  // the tier alone cannot tell them apart.
  it("folds in what the running agent advertised, so one transport can publish two answers", () => {
    const tier = chatTier("acp");
    const floor = publishedCapabilities(tier).map((c) => c.key);
    expect(floor).not.toContain("history");
    expect(floor).not.toContain("sessions");

    const rich = publishedCapabilities(tier, { loadSession: true, listSessions: true });
    expect(rich.map((c) => c.key)).toEqual([...floor, "history", "sessions"]);
    expect(rich.find((c) => c.key === "history")?.label).toBe("history: session/load");

    // An agent that advertises nothing publishes nothing extra, and null (a
    // harness whose capabilities are measured rather than asked for) is the
    // same as absent.
    const bare = { loadSession: false, listSessions: false };
    expect(publishedCapabilities(tier, bare).map((c) => c.key)).toEqual(floor);
    expect(publishedCapabilities(tier, null).map((c) => c.key)).toEqual(floor);
  });

  it("does not let an advertisement reach Claude's measured tier", () => {
    // Claude's capabilities are pinned from measurement, so a handshake claim
    // would be a second, weaker source for the same facts. Nothing sends one,
    // and if something did it would still only ever *add* the two advertised
    // rows rather than change a measured value.
    const claude = chatTier("claude_stream_json");
    const measured = publishedCapabilities(claude);
    expect(publishedCapabilities(claude, null)).toEqual(measured);
  });
});
