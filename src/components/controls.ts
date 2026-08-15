// Shared control primitives vocabulary. Kept DOM-free so the logic here is
// unit-testable under the node-env vitest (see scale.ts for the same split).

/** The three control sizes, each mapping to a fixed --control-height* token. */
export type ControlSize = "md" | "sm" | "xs";
