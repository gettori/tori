// The other half of the Rust tail golden (`chat/tail.rs`): the same histories,
// folded whole and folded as summary plus tail, must leave the same values
// behind. Rust writes the file, so a fold rule changed on either side fails.

import { beforeEach, describe, expect, test, vi } from "vitest";
import golden from "./__fixtures__/historyTail.golden.json";
import {
  applyEvent,
  foldHistory,
  initialChat,
  labelsOf,
  prependHistory,
  promptsSent,
  settleBackfill,
  toolCallsSeen,
  type ChatItem,
  type ChatState,
  type ToolItem,
} from "./chatStore";
import { parseChatEvent, type HistoryCursor, type HistorySummary } from "../../utils/chatTypes";
import { nextLabel, seedLabels } from "../../utils/chatCompose";

type Case = {
  name: string;
  start: number;
  pages: [number, number][];
  cursor: HistoryCursor | null;
  summary: HistorySummary;
  full: unknown[];
};

function whole(full: unknown[], inline = true): { s: ChatState; labels: string[] } {
  const s = initialChat("s", inline);
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

function tailed(c: Case, inline = true): { s: ChatState; labels: string[] } {
  const s = initialChat("s", inline);
  const labels = foldHistory(s, { summary: c.summary, events: c.full.slice(c.start), cursor: c.cursor });
  return { s, labels };
}

/** The tail, then every page merged in front of it, newest first. */
function paged(c: Case, inline = true): ChatState {
  const { s } = tailed(c, inline);
  for (const [from, to] of c.pages) prependHistory(s, c.full.slice(from, to));
  return s;
}

/** The panel's touched-files figure, the way `ChatView` derives it. */
function touched(s: ChatState): number {
  const paths = new Set<string>(s.unloaded.touched);
  for (const it of s.items) {
    if (it.kind !== "tool") continue;
    for (const f of it.files) paths.add(f);
    for (const e of it.edits) paths.add(e.path);
  }
  return paths.size;
}

const withoutIds = (items: ChatItem[]) => items.map(({ id: _, ...rest }) => rest);

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

  test("pages back to the first prompt as the whole fold drew it", () => {
    const a = whole(c.full).s;
    const b = paged(c);
    expect(c.pages[c.pages.length - 1][0]).toBe(0);
    expect(withoutIds(b.items)).toEqual(withoutIds(a.items));
    expect(b.toolIndex).toEqual(a.toolIndex);
    expect(b.questionIndex).toEqual(a.questionIndex);
    expect(b.openText).toEqual(a.openText);
    expect(b.openThinking).toEqual(a.openThinking);
    expect(b.laneOfCall).toEqual(a.laneOfCall);
    expect(Object.keys(b.turns).sort()).toEqual(Object.keys(a.turns).sort());
    expect(b.compactions).toBe(a.compactions);
    expect(new Set(b.items.map((i) => i.id)).size).toBe(b.items.length);
  });

  test("lands a live completion on its card after the merge", () => {
    const s = paged(c);
    const [id, at] = Object.entries(s.toolIndex)[0];
    const count = s.items.length;
    applyEvent(s, {
      type: "toolCallCompleted",
      sessionId: "s",
      turnId: "live",
      toolUseId: id,
      status: "ok",
      output: "again",
      files: [],
      durationMs: null,
      summary: null,
      outputTruncated: false,
      patch: [],
    } as never);
    expect(s.items.length).toBe(count);
    expect((s.items[at] as ToolItem).output).toBe("again");
  });

  test.each([true, false])("counts the same figures off rows it never loaded (questions inline: %s)", (inline) => {
    const a = whole(c.full, inline).s;
    for (const b of [tailed(c, inline).s, paged(c, inline)]) {
      expect(promptsSent(b)).toBe(promptsSent(a));
      expect(toolCallsSeen(b)).toBe(toolCallsSeen(a));
      expect(touched(b)).toBe(touched(a));
    }
  });
});
