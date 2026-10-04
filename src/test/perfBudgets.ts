// The webview half of `perf-budgets.json`, held to the same rules as the rust
// half in `src-tauri/src/perf_budgets.rs`, so a row means one thing whichever
// runtime measures it.
import table from "../../perf-budgets.json";

export interface BudgetRow {
  name: string;
  runtime: "rust" | "webview";
  unit: "count" | "bytes";
  budget: number;
  reason: string;
}

const BYTES_SLACK_PERCENT = 10;

export function rows(runtime: BudgetRow["runtime"]): BudgetRow[] {
  return (table as BudgetRow[]).filter((r) => r.runtime === runtime);
}

export function drift(rows: BudgetRow[], measured: Map<string, number>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const actual = measured.get(row.name);
    if (actual === undefined) {
      out.push(`${row.name}: in the table but never measured`);
      continue;
    }
    const { budget } = row;
    if (row.unit === "count" && actual !== budget) {
      out.push(`${row.name}: budget ${budget}, measured ${actual} (${row.reason})`);
    } else if (row.unit === "bytes" && actual > budget) {
      out.push(`${row.name}: budget ${budget} bytes, measured ${actual} (${row.reason})`);
    } else if (row.unit === "bytes" && actual * 100 <= budget * (100 - BYTES_SLACK_PERCENT)) {
      out.push(
        `${row.name}: measured ${actual} bytes, ${BYTES_SLACK_PERCENT}% or more under the budget of ${budget}, lower the row`,
      );
    }
  }
  for (const name of measured.keys()) {
    if (!rows.some((r) => r.name === name)) out.push(`${name}: measured but has no row`);
  }
  return out;
}
