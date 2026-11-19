import type { Range } from "./fuzzy";
import { numberHit, numberQuery, type IssueId } from "./navNumber";

/** One searchable text on a row. `title` is the slot a subsequence may match;
 *  a hidden field is matched but drawn only when it is what matched. */
export type RankField = { slot: string; text: string; hidden?: boolean };

/** A number on a row, weighed by kind in this order: the linked issue, the
 *  pull request, a number in the branch name, an issue a session mentioned. */
export type RankNumber = { kind: "issue" | "pr" | "branch" | "mention"; slot: string; id: IssueId; digitsAt: number };

/** `penalty` is for commands and settings, so a place wins a tie with them. */
export type RankInput = { fields: readonly RankField[]; numbers?: readonly RankNumber[]; penalty?: boolean };

/** `marks` is keyed by slot, so it also says which fields matched. */
export type Ranked<T> = { item: T; score: number; marks: Record<string, Range[]> };

const EXACT = 110;
const PREFIX = 100;
const WORD_START = 85;
const SUBSEQUENCE = 40;
const GAP = 6;
const FIELD_DROP = 10;
const HIDDEN_DROP = 15;
const PENALTY = 6;
const NUMBER_EXACT = { issue: 130, pr: 125, branch: 120, mention: 115 };
const NUMBER_WITHIN = { issue: 70, pr: 65, branch: 60, mention: 55 };

type Hit = { score: number; ranges: Range[]; slot: string };

function matchNumber(word: string, numbers: readonly RankNumber[]): Hit | null {
  const query = numberQuery(word);
  if (!query) return null;
  let best: Hit | null = null;
  for (const n of numbers) {
    const hit = numberHit(query, n.id);
    if (!hit) continue;
    const score = (hit.exact ? NUMBER_EXACT : NUMBER_WITHIN)[n.kind];
    const start = n.digitsAt + hit.digitsAt;
    if (!best || score > best.score)
      best = { score, ranges: [{ start, end: start + query.digits.length }], slot: n.slot };
  }
  return best;
}

function boundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return !/[\p{L}\p{N}]/u.test(prev) || (/\p{Ll}/u.test(prev) && /\p{Lu}/u.test(text[i]));
}

function subsequence(word: string, lower: string): { score: number; ranges: Range[] } | null {
  const ranges: Range[] = [];
  let gaps = 0;
  let j = 0;
  for (let i = 0; i < lower.length && j < word.length; i++) {
    if (lower[i] !== word[j]) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else {
      if (last) gaps++;
      ranges.push({ start: i, end: i + 1 });
    }
    j++;
  }
  return j === word.length ? { score: Math.max(1, SUBSEQUENCE - gaps * GAP), ranges } : null;
}

function matchWord(word: string, field: RankField): { score: number; ranges: Range[] } | null {
  const lower = field.text.toLowerCase();
  const whole = [{ start: 0, end: word.length }];
  if (lower === word) return { score: EXACT, ranges: whole };
  if (lower.startsWith(word)) return { score: PREFIX, ranges: whole };
  for (let i = lower.indexOf(word, 1); i >= 0; i = lower.indexOf(word, i + 1)) {
    if (boundary(field.text, i)) return { score: WORD_START, ranges: [{ start: i, end: i + word.length }] };
  }
  if (field.slot !== "title" || word.length < 2) return null;
  const at = lower.indexOf(word);
  if (at >= 0) return { score: SUBSEQUENCE, ranges: [{ start: at, end: at + word.length }] };
  return /^#?\d+$/.test(word) ? null : subsequence(word, lower);
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The items every word of `query` matches somewhere, best first, ties in the
 *  order given. An empty query keeps every item, in order, unmarked. */
export function rank<T>(items: readonly T[], query: string, input: (item: T) => RankInput): Ranked<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.map((item) => ({ item, score: 0, marks: {} }));
  const out: (Ranked<T> & { at: number })[] = [];
  items.forEach((item, at) => {
    const { fields, numbers, penalty } = input(item);
    const marks: Record<string, Range[]> = {};
    let score = penalty ? -PENALTY : 0;
    for (const word of words) {
      let best = numbers?.length ? matchNumber(word, numbers) : null;
      for (const field of fields) {
        const hit = matchWord(word, field);
        if (!hit) continue;
        const drop = field.slot === "title" ? 0 : field.hidden ? HIDDEN_DROP : FIELD_DROP;
        if (!best || hit.score - drop > best.score)
          best = { score: hit.score - drop, ranges: hit.ranges, slot: field.slot };
      }
      if (!best) return;
      score += best.score;
      marks[best.slot] = [...(marks[best.slot] ?? []), ...best.ranges];
    }
    for (const slot of Object.keys(marks)) marks[slot] = merge(marks[slot]);
    out.push({ item, score, marks, at });
  });
  out.sort((a, b) => b.score - a.score || a.at - b.at);
  return out.map(({ item, score, marks }) => ({ item, score, marks }));
}
