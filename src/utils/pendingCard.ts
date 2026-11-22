import { createLiveSignal } from "../lib/liveState";

/** A session whose chat should bring its waiting approval or question into
 *  view. Held rather than emitted, because the chat tab may mount after the ask. */
const [pendingCard, setPendingCard] = createLiveSignal<string | null>(null);
export { pendingCard, setPendingCard };
