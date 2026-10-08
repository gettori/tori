import { formatDuration } from "../panels/Chat/toolRenderers";
import type { Check, Verdict } from "./chatTypes";

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "Verified",
  failed: "Checks failed",
  unverified: "Unverified",
};

/** One check as a tooltip line: "cargo test: passed in 14.2s". */
export function checkLine(c: Check): string {
  const took = formatDuration(c.durationMs);
  switch (c.result) {
    case "passed":
      return `${c.command}: passed${took ? ` in ${took}` : ""}`;
    case "failed":
      return `${c.command}: failed${c.exitCode !== null ? `, exit ${c.exitCode}` : ""}${took ? ` after ${took}` : ""}`;
    case "notSeen":
      return `${c.command}: ran, exit not seen`;
  }
}

/** The whole answer for a tooltip: what decided it, then every check. */
export function verdictDetail(verdict: Verdict, checks: readonly Check[]): string {
  const head =
    verdict === "unverified" && !checks.length
      ? "Changed code and ran no check."
      : verdict === "unverified"
        ? "No check after the last edit, or its exit was not seen."
        : verdict === "failed"
          ? "The last check after the last edit failed."
          : "The last check after the last edit passed.";
  return [head, ...checks.map(checkLine)].join("\n");
}
