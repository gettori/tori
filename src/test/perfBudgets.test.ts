import { describe, expect, it } from "vitest";
import { drift, type BudgetRow } from "./perfBudgets";

const row = (name: string, unit: BudgetRow["unit"], budget: number): BudgetRow => ({
  name,
  runtime: "webview",
  unit,
  budget,
  reason: "why",
});

const check = (rows: BudgetRow[], measured: [string, number][]) => drift(rows, new Map(measured));

describe("the budget comparator", () => {
  it("holds a count to exactly its budget", () => {
    const rows = [row("c", "count", 5)];
    expect(check(rows, [["c", 5]])).toEqual([]);
    expect(check(rows, [["c", 6]])).toHaveLength(1);
    expect(check(rows, [["c", 4]])).toHaveLength(1);
  });

  it("fails bytes over the budget and well under it", () => {
    const rows = [row("b", "bytes", 1000)];
    expect(check(rows, [["b", 1000]])).toEqual([]);
    expect(check(rows, [["b", 901]])).toEqual([]);
    expect(check(rows, [["b", 1001]])).toHaveLength(1);
    expect(check(rows, [["b", 900]])).toHaveLength(1);
  });

  it("fails a row nobody measures", () => {
    expect(check([row("c", "count", 1)], [])[0]).toContain("never measured");
  });

  it("fails a measurement with no row", () => {
    expect(check([], [["stray", 1]])[0]).toContain("has no row");
  });
});
