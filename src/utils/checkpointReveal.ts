import { createSignal } from "solid-js";

/** A turn to open in the Changes panel's Checkpoints tab. Held rather than
 *  emitted, because the panel and its timeline may mount after the ask. */
export type CheckpointReveal = { sessionId: string; promptTs: number };

const [pendingReveal, setPendingReveal] = createSignal<CheckpointReveal | null>(null);
export { pendingReveal, setPendingReveal };
