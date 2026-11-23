import { runWithOwner } from "solid-js";

// A story seeds module state while it renders, where an owned write throws.
export const seedStores = (write: () => void) => runWithOwner(null, write);
