// "fixes #42" is a sentence far more often than it is a pick, so a number the
// list does not hold resolves only on Tab.
import type { ContentBlock } from "./chatTypes";
import { MAX_COMPLETIONS, rank } from "./composerCompletion";
import type { PullRequest } from "./forgeTypes";

export type PrHit = { kind: "pr"; pr: PullRequest } | { kind: "resolve"; number: number };

/** The rows for a `#` query. Digits match the number: an exact match leads,
 *  and with none the row to resolve that number leads instead, so Enter on it
 *  sends the sentence as typed. Anything else fuzzy matches the title. */
export function prHits(prs: readonly PullRequest[], query: string): PrHit[] {
  const newest = [...prs].sort((a, b) => b.number - a.number);
  if (!/^\d+$/.test(query)) {
    return rank(newest, query, (pr) => pr.title).map((pr) => ({ kind: "pr", pr }));
  }
  const n = Number(query);
  const exact = newest.find((pr) => pr.number === n);
  const lead: PrHit = exact ? { kind: "pr", pr: exact } : { kind: "resolve", number: n };
  const rest = newest
    .filter((pr) => pr !== exact && String(pr.number).startsWith(query))
    .map((pr): PrHit => ({ kind: "pr", pr }));
  return [lead, ...rest].slice(0, MAX_COMPLETIONS);
}

export function prLabel(number: number): string {
  return `[PR ${number}]`;
}

/** A pull request as it stands now, for the note the agent reads it by. */
export function prRef(pr: PullRequest): ContentBlock {
  return {
    type: "ref",
    label: prLabel(pr.number),
    target: {
      kind: "pr",
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: pr.isDraft,
      head: pr.headRef,
      base: pr.baseRef,
    },
  };
}
