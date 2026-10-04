import type { HistoryTail } from "../utils/chatTypes";

/** What `chat_history` answers for a history short enough to come back whole. */
export function wholeHistory(events: unknown[]): HistoryTail {
  return {
    summary: { compactions: 0, compactionReclaimed: 0, contextTokens: null, labels: [], laneEvents: [] },
    events,
    cursor: null,
  };
}
