import { describe, it, expect } from "vitest";
import twoTurns from "../../dev/fixtures/claude/two-turns.jsonl?raw";
import { fmtCost, fmtTokens, turnTokens, usageSummary } from "./chatUsage";
import { applyEvent, initialChat } from "../panels/Chat/chatStore";
import type { ChatEvent, Usage } from "./chatTypes";

const SESSION = "11111111-2222-3333-4444-555555555555";

/** The `result` frames exactly as claude wrote them, so the numbers under test
 *  are the wire's rather than ones invented to make the arithmetic tidy. */
function capturedResults(): { usage: Usage; costUsd: number }[] {
  return twoTurns
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o !== null && o.type === "result")
    .map((o) => {
      const u = o.usage as Record<string, number>;
      return {
        // The same mapping `usage_from` does in claude.rs.
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheWriteTokens: u.cache_creation_input_tokens,
          thinkingTokens: 0,
        },
        costUsd: o.total_cost_usd as number,
      };
    });
}

function completed(turnId: string, r: { usage: Usage; costUsd: number }): ChatEvent {
  return {
    type: "turnCompleted",
    sessionId: SESSION,
    turnId,
    outcome: "completed",
    stopReason: "end_turn",
    usage: r.usage,
    costUsd: r.costUsd,
    permissionDenials: [],
  };
}

describe("the captured result frames", () => {
  // The measurement the whole design rests on. If `total_cost_usd` were
  // session-cumulative, summing it would double count; if it were per turn and
  // Sway read only the last frame, a ten-turn session would report one turn's
  // price as its total. This says which it is, from the capture.
  it("are per turn, not session-cumulative", () => {
    const results = capturedResults();
    expect(results.length).toBe(2);
    // Identical input/output across both turns of one session: a running total
    // could not repeat itself.
    expect(results[0].usage.inputTokens).toBe(results[1].usage.inputTokens);
    expect(results[0].usage.outputTokens).toBe(results[1].usage.outputTokens);
    // And cache writes went *down* between the turns, which rules out a sum.
    expect(results[1].usage.cacheWriteTokens).toBeLessThan(results[0].usage.cacheWriteTokens);
  });
});

describe("usageSummary", () => {
  it("reports nothing before the first turn completes", () => {
    const s = initialChat(SESSION);
    const summary = usageSummary(s);
    expect(summary.turn).toBeNull();
    expect(summary.session).toEqual({ tokens: 0, cost: null, turns: 0 });
  });

  // The verify: the numbers match the result record's usage and total_cost_usd.
  it("matches the captured record for a single turn", () => {
    const [first] = capturedResults();
    const s = initialChat(SESSION);
    applyEvent(s, completed("t1", first));

    const summary = usageSummary(s);
    expect(summary.turn).toEqual({ tokens: turnTokens(first.usage), cost: first.costUsd });
    // 2 + 3 + 15912 + 8395, straight off the wire.
    expect(summary.turn?.tokens).toBe(24312);
    expect(summary.turn?.cost).toBe(0.055789599999999995);
  });

  it("sums both captured turns into the session total", () => {
    const [first, second] = capturedResults();
    const s = initialChat(SESSION);
    applyEvent(s, completed("t1", first));
    applyEvent(s, completed("t2", second));

    const summary = usageSummary(s);
    expect(summary.session.turns).toBe(2);
    expect(summary.session.tokens).toBe(turnTokens(first.usage) + turnTokens(second.usage));
    expect(summary.session.cost).toBeCloseTo(first.costUsd + second.costUsd, 10);
    // The newest turn stays the newest turn, not the total.
    expect(summary.turn?.cost).toBe(second.costUsd);
  });

  // A repeated `turnCompleted` is absorbed by the fold, and the total must be
  // absorbed with it - a redelivered frame doubling the bill would be a nasty
  // way to find out the guard only covered the item list.
  it("does not count a repeated turnCompleted twice", () => {
    const [first] = capturedResults();
    const s = initialChat(SESSION);
    applyEvent(s, completed("t1", first));
    applyEvent(s, completed("t1", first));

    const summary = usageSummary(s);
    expect(summary.session.turns).toBe(1);
    expect(summary.session.cost).toBe(first.costUsd);
  });

  // Mid-turn `usage` events move the context meter, and must not drag the turn
  // figure with them: its cost comes from the `result` frame, so pairing it
  // with a live token count would price a running turn at the last one's rate.
  it("keeps the turn figure on the last completed turn while a new one runs", () => {
    const [first, second] = capturedResults();
    const s = initialChat(SESSION);
    applyEvent(s, completed("t1", first));
    applyEvent(s, { type: "usage", sessionId: SESSION, turnId: "t2", usage: second.usage });

    // The meter sees the new figure...
    expect(s.lastUsage).toEqual(second.usage);
    // ...while the priced readout still describes the turn that has a price.
    expect(usageSummary(s).turn).toEqual({ tokens: turnTokens(first.usage), cost: first.costUsd });
    expect(usageSummary(s).session.turns).toBe(1);
  });

  it("leaves the session cost unknown when no turn reported one", () => {
    const [first] = capturedResults();
    const s = initialChat(SESSION);
    applyEvent(s, { ...completed("t1", first), costUsd: null } as ChatEvent);
    const summary = usageSummary(s);
    expect(summary.session.cost).toBeNull();
    expect(summary.session.turns).toBe(1);
  });
});

describe("formatting", () => {
  it("rounds tokens the way the transcript notices do", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1k");
    expect(fmtTokens(24312)).toBe("24k");
  });

  // Sub-cent turns are the common case in the captures, and rounding them to
  // two places would print every turn as "$0.01" or "$0.00".
  it("keeps sub-cent turns readable instead of rounding them flat", () => {
    expect(fmtCost(0.055789599999999995)).toBe("$0.06");
    expect(fmtCost(0.0004)).toBe("$0.0004");
    expect(fmtCost(0)).toBe("$0");
  });
});
