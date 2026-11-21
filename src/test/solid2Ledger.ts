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

export const ENFORCED: readonly IdiomClass[] = [
  "boolean-attr",
  "destructured-props",
  "lowercase-on",
  "on-namespace",
  "use-directive",
];

export const LEDGER: Partial<Record<IdiomClass, readonly LedgerEntry[]>> = {
  "boolean-attr": [
    {
      file: "src/components/IconButton/IconButton.tsx",
      count: 1,
      reason:
        "merges an explicit aria-pressed with active in an accessor that returns strings; written inline, the compiler wraps the nested ternary in memos and the tab switch row gains 4 runs",
    },
  ],
};
