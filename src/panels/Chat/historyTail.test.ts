// The other half of the Rust tail golden (`chat/tail.rs`): the same histories,
// folded whole and folded as summary plus tail, must leave the same values
// behind. Rust writes the file, so a fold rule changed on either side fails.

import { beforeEach, describe, expect, test, vi } from "vitest";
import golden from "./__fixtures__/historyTail.golden.json";
import { applyEvent, foldHistory, initialChat, labelsOf, settleBackfill, type ChatState } from "./chatStore";
import { parseChatEvent, type HistoryCursor, type HistorySummary } from "../../utils/chatTypes";
import { nextLabel, seedLabels } from "../../utils/chatCompose";

type Case = { name: string; start: number; cursor: HistoryCursor | null; summary: HistorySummary; full: unknown[] };

function whole(full: unknown[]): { s: ChatState; labels: string[] } {
  const s = initialChat("s");
  const labels: string[] = [];
  for (const raw of full) {
    const ev = parseChatEvent(raw);
    if (!ev) continue;
    applyEvent(s, ev);
    if (ev.type === "userMessage") labels.push(...labelsOf(ev.blocks));
  }
  settleBackfill(s);
  return { s, labels };
}

function tailed(c: Case): { s: ChatState; labels: string[] } {
  const s = initialChat("s");
  const labels = foldHistory(s, { summary: c.summary, events: c.full.slice(c.start), cursor: c.cursor });
  return { s, labels };
}

describe.each(golden as Case[])("the $name history", (c) => {
  // A lane is stamped with when the fold met it, which two folds never share.
  beforeEach(() => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    return () => vi.useRealTimers();
  });

  test("is long enough to cut", () => {
    expect(c.start).toBeGreaterThan(0);
  });

  test("leaves the same figures folded as a tail as it does whole", () => {
    const a = whole(c.full).s;
    const b = tailed(c).s;
    expect(b.compactions).toBe(a.compactions);
    expect(b.compactionReclaimed).toBe(a.compactionReclaimed);
    expect(b.contextTokens).toBe(a.contextTokens);
    expect(b.lanes).toEqual(a.lanes);
    expect(b.laneOfCall).toEqual(a.laneOfCall);
  });

  test("hands the composer every label the whole history used", () => {
    expect(tailed(c).labels).toEqual(whole(c.full).labels);
  });

  test("numbers the next attachment after the ones before the cut", () => {
    const key = `golden-${c.name}`;
    seedLabels(key, tailed(c).labels);
    expect(nextLabel(key, "image")).toBe("[Image 2]");
  });
});
