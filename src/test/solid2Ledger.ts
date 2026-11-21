export type IdiomClass =
  | "batch"
  | "boolean-attr"
  | "camelcase-attr"
  | "cleanup-in-ref"
  | "destructured-props"
  | "effect-in-handler"
  | "effect-writes"
  | "function-signal"
  | "handler-ternary"
  | "lowercase-on"
  | "nested-root"
  | "on-namespace"
  | "onmount-primitive"
  | "read-after-write"
  | "timing"
  | "top-prop-read"
  | "use-directive";

export interface LedgerEntry {
  file: string;
  count: number;
  reason: string;
}

export const ENFORCED: readonly IdiomClass[] = ["destructured-props", "lowercase-on", "on-namespace", "use-directive"];

export const LEDGER: Partial<Record<IdiomClass, readonly LedgerEntry[]>> = {};
