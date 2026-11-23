import { runWithOwner } from "solid-js";
import { withoutFlush } from "../src/lib/liveState";

// A story seeds module state while it renders. Owned writes throw, and the flush
// a live write makes would run the half mounted story early.
export const seedStores = (write: () => void) => runWithOwner(null, () => withoutFlush(write));
